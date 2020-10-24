import {
  createStructuralDirectiveTransform,
  TransformContext,
  traverseNode
} from '../transform'
import {
  NodeTypes,
  ElementTypes,
  ElementNode,
  DirectiveNode,
  IfBranchNode,
  SimpleExpressionNode,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  createObjectProperty,
  createObjectExpression,
  IfConditionalExpression,
  BlockCodegenNode,
  IfNode,
  createVNodeCall,
  AttributeNode,
  locStub,
  CacheExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import {
  CREATE_BLOCK,
  FRAGMENT,
  CREATE_COMMENT,
  OPEN_BLOCK
} from '../runtimeHelpers'
import { injectProp, findDir, findProp } from '../utils'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

// 处理v-if指令
export const transformIf = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  (node, dir, context) => {
    return processIf(node, dir, context, (ifNode, branch, isRoot) => {
      // #1587: We need to dynamically increment the key based on the current
      // node's sibling nodes, since chained v-if/else branches are
      // rendered at the same depth
      const siblings = context.parent!.children // 由于调用了context.replaceNode()方法，已经将原节点替换为ifNode节点
      let i = siblings.indexOf(ifNode) // ifNode的下标位置
      let key = 0
      while (i-- >= 0) {
        const sibling = siblings[i]
        if (sibling && sibling.type === NodeTypes.IF) {
          key += sibling.branches.length
        }
      }

      // Exit callback. Complete the codegenNode when all children have been
      // transformed.
      return () => {
        // Todo isRoot的作用是什么？猜测：这里的isRoot用于确定branch参数是v-if指令还是v-else-if/v-else指令，如果isRoot为true，则是v-if指令，如果为false，则是v-else-if/v-else指令
        if (isRoot) {
          // Todo 猜测：codegenNode的作用是用于生成相应的编译字符串
          ifNode.codegenNode = createCodegenNodeForBranch(
            branch,
            key,
            context
          ) as IfConditionalExpression
        } else { // Todo 这个分支的代码不知道是干嘛的
          // attach this branch's codegen node to the v-if root.
          const parentCondition = getParentCondition(ifNode.codegenNode!)
          parentCondition.alternate = createCodegenNodeForBranch(
            branch,
            key + ifNode.branches.length - 1,
            context
          )
        }
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processIf(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean
  ) => (() => void) | undefined
) {
  if (
    dir.name !== 'else' &&
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim())
  ) { // v-if和v-else-if必须有表达式
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc)
    )
    dir.exp = createSimpleExpression(`true`, false, loc)
  }

  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (__DEV__ && __BROWSER__ && dir.exp) {
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (dir.name === 'if') {
    const branch = createIfBranch(node, dir)
    const ifNode: IfNode = {
      type: NodeTypes.IF,
      loc: node.loc,
      branches: [branch]
    }
    context.replaceNode(ifNode)
    if (processCodegen) {
      return processCodegen(ifNode, branch, true)
    }
  } else {
    // locate the adjacent v-if
    const siblings = context.parent!.children
    const comments = []
    // 当前节点在父元素中的位置
    let i = siblings.indexOf(node)
    // 为什么要这么判断，这样的话i在while循环里可能会是-1或-2
    // 答：注意while循环中最后的break，也就是说，如果v-else-if或v-else指令之前没有注释或者空白符，则只会循环一次
    // 对于i-- >= -1的判断条件，如果node不在siblings中，则初始情况下，i就是-1，此时也会运行while循环（因为i--，先比较，后--，也就是第一步i >= -1，第二步i = i - 1），
    // 然后，就可以报错
    while (i-- >= -1) {
      const sibling = siblings[i]
      if (__DEV__ && sibling && sibling.type === NodeTypes.COMMENT) { // 注释
        context.removeNode(sibling)
        comments.unshift(sibling)
        continue
      }

      if (
        sibling &&
        sibling.type === NodeTypes.TEXT &&
        // Todo 什么时候回出现为空的兄弟元素？
        !sibling.content.trim().length
      ) { // 空白符
        context.removeNode(sibling)
        continue
      }

      if (sibling && sibling.type === NodeTypes.IF) {
        // move the node to the if node's branches
        // 将存在v-else-if、v-else指令的节点删除，因为节点会放入IfNode中，详情可查看compiler-core/src/ast.ts --> IfNode接口中的注释
        context.removeNode()
        const branch = createIfBranch(node, dir)
        if (__DEV__ && comments.length) {
          branch.children = [...comments, ...branch.children]
        }

        // check if user is forcing same key on different branches
        if (__DEV__ || !__BROWSER__) {
          const key = branch.userKey
          if (key) {
            sibling.branches.forEach(({ userKey }) => {
              if (isSameKey(userKey, key)) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_IF_SAME_KEY,
                    branch.userKey!.loc
                  )
                )
              }
            })
          }
        }

        sibling.branches.push(branch)
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        traverseNode(branch, context)
        // call on exit
        if (onExit) onExit()
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        context.currentNode = null
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
        )
      }
      break
    }
  }
}

function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  return {
    type: NodeTypes.IF_BRANCH,
    loc: node.loc,
    condition: dir.name === 'else' ? undefined : dir.exp,
    children:
      node.tagType === ElementTypes.TEMPLATE && !findDir(node, 'for')
        // 如果v-if、v-else-if、v-else指令在template标签上，并且没有v-for指令，则忽略template标签，直接使用其内部子元素
        ? node.children
        // 否则，当前节点就是其子元素
        : [node],
    userKey: findProp(node, `key`)
  }
}

function createCodegenNodeForBranch(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): IfConditionalExpression | BlockCodegenNode {
  if (branch.condition) {
    return createConditionalExpression(
      branch.condition,
      createChildrenCodegenNode(branch, keyIndex, context),
      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      createCallExpression(context.helper(CREATE_COMMENT), [
        __DEV__ ? '"v-if"' : '""',
        'true'
      ])
    ) as IfConditionalExpression
  } else {
    return createChildrenCodegenNode(branch, keyIndex, context)
  }
}

function createChildrenCodegenNode(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): BlockCodegenNode {
  const { helper } = context
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(`${keyIndex}`, false, locStub, true)
  )
  const { children } = branch
  const firstChild = children[0]
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT
  if (needFragmentWrapper) {
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) {
      // optimize away nested fragments when child is a ForNode
      const vnodeCall = firstChild.codegenNode!
      injectProp(vnodeCall, keyProperty, context)
      return vnodeCall
    } else {
      return createVNodeCall(
        context,
        helper(FRAGMENT),
        createObjectExpression([keyProperty]),
        children,
        `${PatchFlags.STABLE_FRAGMENT} /* ${
          PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
        } */`,
        undefined,
        undefined,
        true,
        false,
        branch.loc
      )
    }
  } else {
    const vnodeCall = (firstChild as ElementNode)
      .codegenNode as BlockCodegenNode
    // Change createVNode to createBlock.
    if (vnodeCall.type === NodeTypes.VNODE_CALL) {
      vnodeCall.isBlock = true
      helper(OPEN_BLOCK)
      helper(CREATE_BLOCK)
    }
    // inject branch key
    injectProp(vnodeCall, keyProperty, context)
    return vnodeCall
  }
}

function isSameKey(
  a: AttributeNode | DirectiveNode | undefined,
  b: AttributeNode | DirectiveNode
): boolean {
  if (!a || a.type !== b.type) {
    return false
  }
  if (a.type === NodeTypes.ATTRIBUTE) {
    if (a.value!.content !== (b as AttributeNode).value!.content) {
      return false
    }
  } else {
    // directive
    const exp = a.exp!
    const branchExp = (b as DirectiveNode).exp!
    if (exp.type !== branchExp.type) {
      return false
    }
    if (
      exp.type !== NodeTypes.SIMPLE_EXPRESSION ||
      (exp.isStatic !== (branchExp as SimpleExpressionNode).isStatic ||
        exp.content !== (branchExp as SimpleExpressionNode).content)
    ) {
      return false
    }
  }
  return true
}

function getParentCondition(
  node: IfConditionalExpression | CacheExpression
): IfConditionalExpression {
  while (true) {
    if (node.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
      if (node.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
        node = node.alternate
      } else {
        return node
      }
    } else if (node.type === NodeTypes.JS_CACHE_EXPRESSION) {
      node = node.value as IfConditionalExpression
    }
  }
}
