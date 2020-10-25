import { TransformOptions } from './options'
import {
  RootNode,
  NodeTypes,
  ParentNode,
  TemplateChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode,
  SimpleExpressionNode,
  ElementTypes,
  CacheExpression,
  createCacheExpression,
  TemplateLiteral,
  createVNodeCall
} from './ast'
import {
  isString,
  isArray,
  NOOP,
  PatchFlags,
  PatchFlagNames
} from '@vue/shared'
import { defaultOnError } from './errors'
import {
  TO_DISPLAY_STRING,
  FRAGMENT,
  helperNameMap,
  CREATE_BLOCK,
  CREATE_COMMENT,
  OPEN_BLOCK
} from './runtimeHelpers'
import { isVSlot } from './utils'
import { hoistStatic, isSingleElementRoot } from './transforms/hoistStatic'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  // a platform specific compiler can import the base transform and augment
  // it by passing in this optional argument.
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult
) => DirectiveTransformResult

export interface DirectiveTransformResult {
  props: Property[]
  needRuntime?: boolean | symbol
  ssrTagParts?: TemplateLiteral['elements']
}

// A structural directive transform is a technically a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface ImportItem {
  exp: string | ExpressionNode
  path: string
}

export interface TransformContext extends Required<TransformOptions> {
  // 组件的模板字符串的根节点
  root: RootNode
  // 保存需要引入的vue帮助方法
  helpers: Set<symbol>
  // 保存当前编译字符串上下文中会用的所有自定义组件
  components: Set<string>
  // 保存当前编译字符串上下文中会用的所有自定义指令
  directives: Set<string>
  hoists: (JSChildNode | null)[]
  imports: Set<ImportItem>
  temps: number
  cached: number
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  // currentNode的父节点
  parent: ParentNode | null
  // currentNode在parent中的位置下标
  childIndex: number
  // 当前正在处理的节点
  currentNode: RootNode | TemplateChildNode | null
  helper<T extends symbol>(name: T): T
  helperString(name: symbol): string
  replaceNode(node: TemplateChildNode): void
  // 删除节点的方法，在该方法内部调用context.onNodeRemoved()方法
  removeNode(node?: TemplateChildNode): void
  // 如果有节点被删除，需要调用该方法
  onNodeRemoved(): void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: JSChildNode): SimpleExpressionNode
  cache<T extends JSChildNode>(exp: T, isVNode?: boolean): CacheExpression | T
}

export function createTransformContext(
  root: RootNode,
  {
    prefixIdentifiers = false,
    hoistStatic = false,
    cacheHandlers = false,
    nodeTransforms = [],
    directiveTransforms = {},
    transformHoist = null,
    isBuiltInComponent = NOOP,
    isCustomElement = NOOP,
    expressionPlugins = [],
    scopeId = null,
    ssr = false,
    ssrCssVars = ``,
    bindingMetadata = {},
    onError = defaultOnError
  }: TransformOptions
): TransformContext {
  const context: TransformContext = {
    // options
    prefixIdentifiers,
    hoistStatic,
    cacheHandlers,
    nodeTransforms,
    directiveTransforms,
    transformHoist,
    isBuiltInComponent,
    isCustomElement,
    expressionPlugins,
    scopeId,
    ssr,
    ssrCssVars,
    bindingMetadata,
    onError,

    // state
    root,
    helpers: new Set(),
    components: new Set(),
    directives: new Set(),
    hoists: [],
    imports: new Set(),
    temps: 0,
    cached: 0,
    identifiers: Object.create(null),
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0
    },
    parent: null,
    currentNode: root,
    childIndex: 0,

    // methods
    helper(name) {
      context.helpers.add(name)
      return name
    },
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`
    },
    // 使用node替换父元素中对应的子节点以及当前正在处理的节点
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__) {
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
          ? context.childIndex
          : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    hoist(exp) {
      context.hoists.push(exp)
      const identifier = createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc,
        true
      )
      identifier.hoisted = exp
      return identifier
    },
    cache(exp, isVNode = false) {
      return createCacheExpression(++context.cached, exp, isVNode)
    }
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    identifiers[id]!++
  }

  function removeId(id: string) {
    context.identifiers[id]!--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions) {
  const context = createTransformContext(root, options)
  traverseNode(root, context)
  if (options.hoistStatic) {
    hoistStatic(root, context)
  }
  if (!options.ssr) {
    createRootCodegen(root, context)
  }
  // finalize meta information
  root.helpers = [...context.helpers]
  root.components = [...context.components]
  root.directives = [...context.directives]
  root.imports = [...context.imports]
  root.hoists = context.hoists
  root.temps = context.temps
  root.cached = context.cached
}

function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  if (children.length === 1) {
    const child = children[0]
    // if the single child is an element, turn it into a block.
    if (isSingleElementRoot(root, child) && child.codegenNode) {
      // single element root is never hoisted so codegenNode will never be
      // SimpleExpressionNode
      const codegenNode = child.codegenNode
      if (codegenNode.type === NodeTypes.VNODE_CALL) {
        codegenNode.isBlock = true
        helper(OPEN_BLOCK)
        helper(CREATE_BLOCK)
      }
      root.codegenNode = codegenNode
    } else {
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // root codegen falls through via genNode()
      root.codegenNode = child
    }
  } else if (children.length > 1) {
    // root has multiple nodes - return a fragment block.
    root.codegenNode = createVNodeCall(
      context,
      helper(FRAGMENT),
      undefined,
      root.children,
      `${PatchFlags.STABLE_FRAGMENT} /* ${
        PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
      } */`,
      undefined,
      undefined,
      true
    )
  } else {
    // no children = noop. codegen will return null.
  }
}

// 遍历parent父元素节点的所有子节点，并进行转换
export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    // Todo 什么情况下，child会是字符串？
    if (isString(child)) continue
    context.parent = parent
    context.childIndex = i
    context.onNodeRemoved = nodeRemoved
    traverseNode(child, context)
  }
}

// Todo 该方法作用的暂时性想法：用于将一种类型的节点转换为另一种类型的节点
export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext
) {
  context.currentNode = node
  // apply transform plugins
  // 正常流程中，有两处传入了nodeTransform：
  // 1）compiler-dom/src/index --> compile()
  // 2）在compiler-core/src/compile.ts --> getBaseTransformPreset()
  const { nodeTransforms } = context
  const exitFns = []
  // 使用所有nodeTransforms对node进行处理
  for (let i = 0; i < nodeTransforms.length; i++) {
    const onExit = nodeTransforms[i](node, context)
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    if (!context.currentNode) {
      // node was removed
      return
    } else {
      // node may have been replaced
      node = context.currentNode
    }
  }

  switch (node.type) {
    case NodeTypes.COMMENT:
      if (!context.ssr) {
        // inject import for the Comment symbol, which is needed for creating
        // comment nodes with `createVNode`
        context.helper(CREATE_COMMENT)
      }
      break
    case NodeTypes.INTERPOLATION: // 插值操作符
      // no need to traverse, but we need to inject toString helper
      if (!context.ssr) {
        context.helper(TO_DISPLAY_STRING)
      }
      break

    // for container types, further traverse downwards
    // 这里处理的只是v-if指令的子元素，对于v-else-if和v-else来说，是在compiler-core/src/transforms/vIf.ts中处理的，可查看该文件中调用traverseNode()方法的相关代码
    case NodeTypes.IF:
      // 正如在compiler-core/src/ast.ts --> IfNode接口中的注释，对于NodeTypes.IF类型的节点，
      // 其对应的真正节点在branches数组中
      for (let i = 0; i < node.branches.length; i++) {
        traverseNode(node.branches[i], context)
      }
      break
    case NodeTypes.IF_BRANCH:
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      traverseChildren(node, context)
      break
  }

  // exit transforms
  context.currentNode = node
  let i = exitFns.length
  while (i--) { // 注意exitFns的执行顺序，从后向前执行
    exitFns[i]()
  }
}

export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  return (node, context) => {
    // 结构性指令只处理元素节点
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      // 结构性指令转换器不关心插槽，他们在vSlot.ts中单独处理
      // 当template元素上没有插槽指令（v-slot或#）时，template会作为html原生元素处理
      /**
       * 例子：
       * Hello.vue：
       * <div class="hello">
       *   <slot></slot>
       * </div>
       *
       * Test1.vue：
       * <Hello>
       *   <template #default>
       *     <div>Hello</div>
       *   </template>
       * </Hello>
       * 最终生成的dom结构为：
       * <div class="hello">
       *   <div>Hello</div>
       * </div>
       *
       * Test2.vue：
       * <Hello>
       *   <template>
       *     <div>Hello</div>
       *   </template>
       * </Hello>
       * 最终生成的dom结构为：
       * <div class="hello">
       *   <template>
       *     <div>Hello</div>
       *   </template>
       * </div>
       */
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) {
        return
      }
      const exitFns = []
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around
          // 删除结构性指令以避免无限递归，此外，我们在应用它们之前删除它们，它可以进一步
          // 遍历自身，以防它移动节点。Todo 自己翻译的，自己都看不懂。。。
          props.splice(i, 1)
          i--
          const onExit = fn(node, prop, context)
          if (onExit) exitFns.push(onExit)
        }
      }
      return exitFns
    }
  }
}
