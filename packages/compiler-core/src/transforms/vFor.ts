import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  CREATE_BLOCK,
  FRAGMENT
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// 处理v-for指令
export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper } = context
    return processFor(node, dir, context, forNode => {
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      const renderExp = createCallExpression(helper(RENDER_LIST), [
        forNode.source
      ]) as ForRenderListExpression
      const keyProp = findProp(node, `key`)
      const keyProperty = keyProp
        ? createObjectProperty(
            `key`,
            // <div key="test"></div>以这种方式声明的普通特性
            keyProp.type === NodeTypes.ATTRIBUTE
              ? createSimpleExpression(keyProp.value!.content, true)
              // <div :key="test"></div>以这种方式声明的指令特性
              : keyProp.exp!
          )
        : null

      if (!__BROWSER__ && context.prefixIdentifiers && keyProperty) {
        // #2085 process :key expression needs to be processed in order for it
        // to behave consistently for <template v-for> and <div v-for>.
        // In the case of `<template v-for>`, the node is discarded and never
        // traversed so its key expression won't be processed by the normal
        // transforms.
        keyProperty.value = processExpression(
          keyProperty.value as SimpleExpressionNode,
          context
        )
      }

      const isStableFragment =
        // Todo 什么情况下，source不是简单表达式？
        forNode.source.type === NodeTypes.SIMPLE_EXPRESSION &&
        // Todo 创建forNode.source时，isConstant参数为false，什么情况下会被设置为true
        forNode.source.isConstant
      const fragmentFlag = isStableFragment
        ? PatchFlags.STABLE_FRAGMENT
        : keyProp
          ? PatchFlags.KEYED_FRAGMENT
          : PatchFlags.UNKEYED_FRAGMENT
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT),
        undefined,
        renderExp,
        `${fragmentFlag} /* ${PatchFlagNames[fragmentFlag]} */`,
        undefined,
        undefined,
        true /* isBlock */,
        !isStableFragment /* disableTracking */,
        node.loc
      ) as ForCodegenNode

      return () => {
        // finish the codegen now that all children have been traversed
        let childBlock: BlockCodegenNode
        const isTemplate = isTemplateNode(node)
        const { children } = forNode

        // check <template v-for> key placement
        if ((__DEV__ || !__BROWSER__) && isTemplate) {
          node.children.some(c => {
            if (c.type === NodeTypes.ELEMENT) {
              const key = findProp(c, 'key')
              if (key) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                    key.loc
                  )
                )
                return true
              }
            }
          })
        }

        const needFragmentWrapper =
          children.length !== 1 || children[0].type !== NodeTypes.ELEMENT
        const slotOutlet = isSlotOutlet(node)
          ? node
          : isTemplate &&
            node.children.length === 1 &&
            isSlotOutlet(node.children[0])
            ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
            : null

        if (slotOutlet) {
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            injectProp(childBlock, keyProperty, context)
          }
        } else if (needFragmentWrapper) {
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children,
            `${PatchFlags.STABLE_FRAGMENT} /* ${
              PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
            } */`,
            undefined,
            undefined,
            true
          )
        } else {
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall
          if (isTemplate && keyProperty) {
            injectProp(childBlock, keyProperty, context)
          }
          childBlock.isBlock = !isStableFragment
          if (childBlock.isBlock) {
            helper(OPEN_BLOCK)
            helper(CREATE_BLOCK)
          }
        }

        renderExp.arguments.push(createFunctionExpression(
          createForLoopParams(forNode.parseResult),
          childBlock,
          true /* force newline */
        ) as ForIteratorExpression)
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode,
    context
  )

  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  const { addIdentifiers, removeIdentifiers, scopes } = context
  const { source, value, key, index } = parseResult

  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,
    objectIndexAlias: index,
    parseResult,
    // 当node不是template标签时，以当前节点作为子节点，这样就可以继续处理剩余的特性节点了
    children: isTemplateNode(node) ? node.children : [node]
  }

  context.replaceNode(forNode)

  // bookkeeping
  // Todo 作用是什么？好像是在compiler-dom/src/transforms/vSlot.ts --> ()方法中有用到
  scopes.vFor++
  // Todo 正常流程中，context.prefixIdentifiers为false，所以暂不研究这里的分支
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value)
    key && addIdentifiers(key)
    index && addIdentifiers(index)
  }

  const onExit = processCodegen && processCodegen(forNode)

  return () => {
    scopes.vFor--
    if (!__BROWSER__ && context.prefixIdentifiers) {
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    if (onExit) onExit()
  }
}

// 例子：v-for="(option, index)  in options"
// 第一个分组：([\s\S]*?)匹配："(option, index)"
// 第二个分组：([\s\S]*)匹配："options"
const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
// 例子：v-for="(value, name, index) in object"
// 第一个分组：([^,\}\]]*)匹配：" name"
// 第二个分组匹配：([^,\}\]]*)匹配：" index"
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

// 例子：v-for="(value, name, index) in object"
// 另外，由测试用例可知，也支持v-for="value, key, index in items"这种形式的写法
export interface ForParseResult {
  // 上例中"object"的相关信息
  source: ExpressionNode
  // 上例中"value"的相关信息
  value: ExpressionNode | undefined
  // 上例中"name"的相关信息
  key: ExpressionNode | undefined
  // 上例中"index"的相关信息
  index: ExpressionNode | undefined
}

export function parseForExpression(
  input: SimpleExpressionNode,
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  // 例子：v-for="(option, index)  in options"
  // LHS："(option, index)"
  // RHS："options"
  const [, LHS, RHS] = inMatch

  const result: ForParseResult = {
    source: createAliasExpression(
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined,
    key: undefined,
    index: undefined
  }
  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }

  // "(option, index)" --> "option, index"
  let valueContent = LHS.trim()
    .replace(stripParensRE, '')
    .trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  const iteratorMatch = valueContent.match(forIteratorRE)
  // 例子：v-for="(value, name, index) in object"
  if (iteratorMatch) {
    // 上例中的"value"
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    // 上例中的"name"
    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      // keyOffset在整个exp中下标的位置
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(loc, keyContent, keyOffset)
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    if (iteratorMatch[2]) {
      // 上例中的"index"
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  if (valueContent) {
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

function createAliasExpression(
  range: SourceLocation,
  content: string,
  offset: number
): SimpleExpressionNode {
  return createSimpleExpression(
    content,
    false,
    // 生成表达式的位置信息
    getInnerRange(range, offset, content.length)
  )
}

export function createForLoopParams({
  value,
  key,
  index
}: ForParseResult): ExpressionNode[] {
  const params: ExpressionNode[] = []
  if (value) {
    params.push(value)
  }
  if (key) {
    if (!value) {
      params.push(createSimpleExpression(`_`, false))
    }
    params.push(key)
  }
  if (index) {
    if (!key) {
      if (!value) {
        params.push(createSimpleExpression(`_`, false))
      }
      params.push(createSimpleExpression(`__`, false))
    }
    params.push(index)
  }
  return params
}
