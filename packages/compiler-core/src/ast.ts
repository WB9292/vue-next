import { isString } from '@vue/shared'
import { ForParseResult } from './transforms/vFor'
import {
  RENDER_SLOT,
  CREATE_SLOTS,
  RENDER_LIST,
  OPEN_BLOCK,
  CREATE_BLOCK,
  FRAGMENT,
  CREATE_VNODE,
  WITH_DIRECTIVES
} from './runtimeHelpers'
import { PropsExpression } from './transforms/transformElement'
import { ImportItem, TransformContext } from './transform'

// Vue template is a platform-agnostic superset of HTML (syntax only).
// More namespaces like SVG and MathML are declared by platform specific
// compilers.
export type Namespace = number

export const enum Namespaces {
  HTML
}

export const enum NodeTypes {
  // 一个组件元素的根节点
  ROOT,
  // 元素节点
  ELEMENT,
  // 纯文本节点
  TEXT,
  // 注释节点
  COMMENT,
  SIMPLE_EXPRESSION,
  // 插值操作符，{{}}
  INTERPOLATION,
  // html标签上的普通特性，不是指令特性
  ATTRIBUTE,
  // 指令特性
  DIRECTIVE,
  // containers，表示是多个表达式的组合
  COMPOUND_EXPRESSION,
  // 存在v-if指令的节点
  IF,
  // v-if、v-else-if、v-else对应的真实节点，详情可查看IfNode接口中的相关注释
  IF_BRANCH,
  FOR,
  TEXT_CALL,
  // codegen
  VNODE_CALL,
  // Todo 猜测：最终会被编译为方法调用的表达式
  JS_CALL_EXPRESSION,
  JS_OBJECT_EXPRESSION,
  // Todo 猜测：代表标签上（可能不一定是标签上）的特性的键值对属性的表示
  JS_PROPERTY,
  JS_ARRAY_EXPRESSION,
  JS_FUNCTION_EXPRESSION,
  JS_CONDITIONAL_EXPRESSION,
  JS_CACHE_EXPRESSION,

  // ssr codegen
  JS_BLOCK_STATEMENT,
  JS_TEMPLATE_LITERAL,
  JS_IF_STATEMENT,
  JS_ASSIGNMENT_EXPRESSION,
  JS_SEQUENCE_EXPRESSION,
  JS_RETURN_STATEMENT
}

// 将html标签元素分为四种类型
export const enum ElementTypes {
  // 普通html元素
  ELEMENT,
  // 组件
  COMPONENT,
  // slot元素，插槽
  SLOT,
  // template元素，并且标签上有v-if,v-else,v-else-if,v-for,v-slot指令时
  TEMPLATE
}

export interface Node {
  // 节点类型
  type: NodeTypes
  loc: SourceLocation
}

// The node's range. The `start` is inclusive and `end` is exclusive.
// [start, end)
// source对应的内容在原始待编译字符串中的位置信息
export interface SourceLocation {
  // 开始位置
  start: Position
  // 结束位置
  end: Position
  // start到end之间的原始内容：[start, end)，包含start指向位置的内容，不包含end指向位置的内容
  source: string
}

export interface Position {
  offset: number // from start of file
  line: number
  column: number
}

export type ParentNode = RootNode | ElementNode | IfBranchNode | ForNode

// Todo 猜测：表达式节点是会动态计算的节点
export type ExpressionNode = SimpleExpressionNode | CompoundExpressionNode

export type TemplateChildNode =
  | ElementNode
  | InterpolationNode
  | CompoundExpressionNode
  | TextNode
  | CommentNode
  | IfNode
  | IfBranchNode
  | ForNode
  | TextCallNode

export interface RootNode extends Node {
  type: NodeTypes.ROOT
  children: TemplateChildNode[]
  helpers: symbol[]
  components: string[]
  directives: string[]
  hoists: (JSChildNode | null)[]
  imports: ImportItem[]
  cached: number
  temps: number
  ssrHelpers?: symbol[]
  codegenNode?: TemplateChildNode | JSChildNode | BlockStatement | undefined
}

export type ElementNode =
  | PlainElementNode
  | ComponentNode
  | SlotOutletNode
  | TemplateNode

export interface BaseElementNode extends Node {
  type: NodeTypes.ELEMENT
  ns: Namespace
  // 元素标签名
  tag: string
  // 元素标签的类型
  tagType: ElementTypes
  // 是否是自关闭标签
  isSelfClosing: boolean
  // 标签上的所有特性
  props: Array<AttributeNode | DirectiveNode>
  // 子元素数组
  children: TemplateChildNode[]
}

export interface PlainElementNode extends BaseElementNode {
  tagType: ElementTypes.ELEMENT
  codegenNode:
    | VNodeCall
    | SimpleExpressionNode // when hoisted
    | CacheExpression // when cached by v-once
    | undefined
  ssrCodegenNode?: TemplateLiteral
}

export interface ComponentNode extends BaseElementNode {
  tagType: ElementTypes.COMPONENT
  codegenNode:
    | VNodeCall
    | CacheExpression // when cached by v-once
    | undefined
  ssrCodegenNode?: CallExpression
}

export interface SlotOutletNode extends BaseElementNode {
  tagType: ElementTypes.SLOT
  codegenNode:
    | RenderSlotCall
    | CacheExpression // when cached by v-once
    | undefined
  ssrCodegenNode?: CallExpression
}

export interface TemplateNode extends BaseElementNode {
  tagType: ElementTypes.TEMPLATE
  // TemplateNode is a container type that always gets compiled away
  codegenNode: undefined
}

// 纯文本节点
export interface TextNode extends Node {
  type: NodeTypes.TEXT
  content: string
}

export interface CommentNode extends Node {
  type: NodeTypes.COMMENT
  content: string
}

export interface AttributeNode extends Node {
  type: NodeTypes.ATTRIBUTE
  // 特性名
  name: string
  // 特性值，纯文本节点
  value: TextNode | undefined
}

/**
 * 以"v-test:name.one.two="go"为例
 */
export interface DirectiveNode extends Node {
  type: NodeTypes.DIRECTIVE
  // 指令名，"test"
  name: string
  // exp和arg的区别是什么？答：exp保存的是上例中的go相关的内容，而arg保存的是上例中name相关的内容
  // exp中的isStatic属性总是为false，因为指令的值总是动态的
  exp: ExpressionNode | undefined
  arg: ExpressionNode | undefined
  // 修饰符，["one", "two"]
  modifiers: string[]
  /**
   * optional property to cache the expression parse result for v-for
   */
  parseResult?: ForParseResult
}

// Todo 简单表达式到底是什么？
export interface SimpleExpressionNode extends Node {
  type: NodeTypes.SIMPLE_EXPRESSION
  content: string
  // 是否是静态内容，也就是说，content对应的内容在运行时是否需要运行
  isStatic: boolean
  // Todo 什么含义？作用是什么？
  isConstant: boolean
  /**
   * Indicates this is an identifier for a hoist vnode call and points to the
   * hoisted node.
   */
  hoisted?: JSChildNode
  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   */
  identifiers?: string[]
  /**
   * some expressions (e.g. transformAssetUrls import identifiers) are constant,
   * but cannot be stringified because they must be first evaluated at runtime.
   */
  isRuntimeConstant?: boolean
}

/**
 * 插值运算符节点
 * 例子："{{ foo < bar + foo }}"
 * 插值运算符节点表示的是整个运算符
 */
export interface InterpolationNode extends Node {
  type: NodeTypes.INTERPOLATION
  // 插值运算符内容的信息，表示的是"foo < bar + foo"相关的信息
  content: ExpressionNode
}

// 多个表达式的组合，可以认为是一个虚拟的表达式节点，真正的表达式在children属性中
export interface CompoundExpressionNode extends Node {
  type: NodeTypes.COMPOUND_EXPRESSION
  children: (
    | SimpleExpressionNode
    | CompoundExpressionNode
    | InterpolationNode
    | TextNode
    | string
    | symbol)[]

  /**
   * an expression parsed as the params of a function will track
   * the identifiers declared inside the function body.
   */
  identifiers?: string[]
}

export interface IfNode extends Node {
  type: NodeTypes.IF
  /**
   * 比如：
   * <div v-if="num === 1">one</div>
   * <div v-else-if="num === 2">two</div>
   * <div v-else>others</div>
   * 此时，上面的三个节点都会放入branches数组中，类型是if分支节点。
   * 所以，可以认为IfNode节点是一个收集v-if、v-else-if、v-else所有关联分支的一个虚拟节点，
   * branches数组中的节点的children属性中才是真实的的节点
   */
  branches: IfBranchNode[]
  codegenNode?: IfConditionalExpression | CacheExpression // <div v-if v-once>
}

export interface IfBranchNode extends Node {
  type: NodeTypes.IF_BRANCH
  // 对于v-if和v-else-if指令，该属性为DirectiveNode接口中的exp属性的值，对于v-else，为undefined
  condition: ExpressionNode | undefined // else
  // 具体值可查看compiler-core/src/transforms/vIf.ts --> createIfBranch()方法
  children: TemplateChildNode[]
  // key特性，普通特性或指令特性
  userKey?: AttributeNode | DirectiveNode
}

/**
 * compiler-core/src/transforms/vFor.ts --> ForParseResult
 * source --> ForParseResult.source
 * valueAlias --> ForParseResult.value
 * keyAlias --> ForParseResult.key
 * objectIndexAlias --> ForParseResult.index
 * 该接口中保存的值是parseResult对象中对应的值，详情可查看ForParseResult接口中的注释
 */
export interface ForNode extends Node {
  type: NodeTypes.FOR
  source: ExpressionNode
  valueAlias: ExpressionNode | undefined
  keyAlias: ExpressionNode | undefined
  objectIndexAlias: ExpressionNode | undefined
  parseResult: ForParseResult
  children: TemplateChildNode[]
  codegenNode?: ForCodegenNode
}

export interface TextCallNode extends Node {
  type: NodeTypes.TEXT_CALL
  content: TextNode | InterpolationNode | CompoundExpressionNode
  codegenNode: CallExpression | SimpleExpressionNode // when hoisted
}

export type TemplateTextChildNode =
  | TextNode
  | InterpolationNode
  | CompoundExpressionNode

export interface VNodeCall extends Node {
  type: NodeTypes.VNODE_CALL
  tag: string | symbol | CallExpression
  props: PropsExpression | undefined
  children:
    | TemplateChildNode[] // multiple children
    | TemplateTextChildNode // single text child
    | SlotsExpression // component slots
    | ForRenderListExpression // v-for fragment call
    | undefined
  patchFlag: string | undefined
  dynamicProps: string | undefined
  directives: DirectiveArguments | undefined
  isBlock: boolean
  disableTracking: boolean
}

// JS Node Types ---------------------------------------------------------------

// We also include a number of JavaScript AST nodes for code generation.
// The AST is an intentionally minimal subset just to meet the exact needs of
// Vue render function generation.

export type JSChildNode =
  | VNodeCall
  | CallExpression
  | ObjectExpression
  | ArrayExpression
  | ExpressionNode
  | FunctionExpression
  | ConditionalExpression
  | CacheExpression
  | AssignmentExpression
  | SequenceExpression

export interface CallExpression extends Node {
  type: NodeTypes.JS_CALL_EXPRESSION
  // 该属性用于存储标识调用当前表达式的方法，也就是，当需要处理该节点时，使用哪个方法。详情可查看compiler-core/src/runtimeHelpers.ts --> helperNameMap对象映射
  callee: string | symbol
  arguments: (
    | string
    | symbol
    | JSChildNode
    | SSRCodegenNode
    | TemplateChildNode
    | TemplateChildNode[])[]
}

export interface ObjectExpression extends Node {
  type: NodeTypes.JS_OBJECT_EXPRESSION
  properties: Array<Property>
}

export interface Property extends Node {
  type: NodeTypes.JS_PROPERTY
  key: ExpressionNode
  value: JSChildNode
}

// Todo CompoundExpressionNode和ArrayExpression的区别是什么？
export interface ArrayExpression extends Node {
  type: NodeTypes.JS_ARRAY_EXPRESSION
  elements: Array<string | JSChildNode>
}

export interface FunctionExpression extends Node {
  type: NodeTypes.JS_FUNCTION_EXPRESSION
  params: ExpressionNode | string | (ExpressionNode | string)[] | undefined
  returns?: TemplateChildNode | TemplateChildNode[] | JSChildNode
  body?: BlockStatement | IfStatement
  newline: boolean
  /**
   * This flag is for codegen to determine whether it needs to generate the
   * withScopeId() wrapper
   */
  isSlot: boolean
}

export interface ConditionalExpression extends Node {
  type: NodeTypes.JS_CONDITIONAL_EXPRESSION
  test: JSChildNode
  consequent: JSChildNode
  alternate: JSChildNode
  newline: boolean
}

export interface CacheExpression extends Node {
  type: NodeTypes.JS_CACHE_EXPRESSION
  index: number
  value: JSChildNode
  isVNode: boolean
}

// SSR-specific Node Types -----------------------------------------------------

export type SSRCodegenNode =
  | BlockStatement
  | TemplateLiteral
  | IfStatement
  | AssignmentExpression
  | ReturnStatement
  | SequenceExpression

export interface BlockStatement extends Node {
  type: NodeTypes.JS_BLOCK_STATEMENT
  body: (JSChildNode | IfStatement)[]
}

export interface TemplateLiteral extends Node {
  type: NodeTypes.JS_TEMPLATE_LITERAL
  elements: (string | JSChildNode)[]
}

export interface IfStatement extends Node {
  type: NodeTypes.JS_IF_STATEMENT
  test: ExpressionNode
  consequent: BlockStatement
  alternate: IfStatement | BlockStatement | ReturnStatement | undefined
}

export interface AssignmentExpression extends Node {
  type: NodeTypes.JS_ASSIGNMENT_EXPRESSION
  left: SimpleExpressionNode
  right: JSChildNode
}

export interface SequenceExpression extends Node {
  type: NodeTypes.JS_SEQUENCE_EXPRESSION
  expressions: JSChildNode[]
}

export interface ReturnStatement extends Node {
  type: NodeTypes.JS_RETURN_STATEMENT
  returns: TemplateChildNode | TemplateChildNode[] | JSChildNode
}

// Codegen Node Types ----------------------------------------------------------

export interface DirectiveArguments extends ArrayExpression {
  elements: DirectiveArgumentNode[]
}

export interface DirectiveArgumentNode extends ArrayExpression {
  elements:  // dir, exp, arg, modifiers
    | [string]
    | [string, ExpressionNode]
    | [string, ExpressionNode, ExpressionNode]
    | [string, ExpressionNode, ExpressionNode, ObjectExpression]
}

// renderSlot(...)
export interface RenderSlotCall extends CallExpression {
  callee: typeof RENDER_SLOT
  arguments:  // $slots, name, props, fallback
    | [string, string | ExpressionNode]
    | [string, string | ExpressionNode, PropsExpression]
    | [
        string,
        string | ExpressionNode,
        PropsExpression | '{}',
        TemplateChildNode[]
      ]
}

export type SlotsExpression = SlotsObjectExpression | DynamicSlotsExpression

// { foo: () => [...] }
export interface SlotsObjectExpression extends ObjectExpression {
  properties: SlotsObjectProperty[]
}

export interface SlotsObjectProperty extends Property {
  value: SlotFunctionExpression
}

export interface SlotFunctionExpression extends FunctionExpression {
  returns: TemplateChildNode[]
}

// createSlots({ ... }, [
//    foo ? () => [] : undefined,
//    renderList(list, i => () => [i])
// ])
export interface DynamicSlotsExpression extends CallExpression {
  callee: typeof CREATE_SLOTS
  arguments: [SlotsObjectExpression, DynamicSlotEntries]
}

export interface DynamicSlotEntries extends ArrayExpression {
  elements: (ConditionalDynamicSlotNode | ListDynamicSlotNode)[]
}

export interface ConditionalDynamicSlotNode extends ConditionalExpression {
  consequent: DynamicSlotNode
  alternate: DynamicSlotNode | SimpleExpressionNode
}

export interface ListDynamicSlotNode extends CallExpression {
  callee: typeof RENDER_LIST
  arguments: [ExpressionNode, ListDynamicSlotIterator]
}

export interface ListDynamicSlotIterator extends FunctionExpression {
  returns: DynamicSlotNode
}

export interface DynamicSlotNode extends ObjectExpression {
  properties: [Property, DynamicSlotFnProperty]
}

export interface DynamicSlotFnProperty extends Property {
  value: SlotFunctionExpression
}

export type BlockCodegenNode = VNodeCall | RenderSlotCall

export interface IfConditionalExpression extends ConditionalExpression {
  consequent: BlockCodegenNode
  alternate: BlockCodegenNode | IfConditionalExpression
}

export interface ForCodegenNode extends VNodeCall {
  isBlock: true
  tag: typeof FRAGMENT
  props: undefined
  children: ForRenderListExpression
  patchFlag: string
  disableTracking: boolean
}

export interface ForRenderListExpression extends CallExpression {
  callee: typeof RENDER_LIST
  arguments: [ExpressionNode, ForIteratorExpression]
}

export interface ForIteratorExpression extends FunctionExpression {
  returns: BlockCodegenNode
}

// AST Utilities ---------------------------------------------------------------

// Some expressions, e.g. sequence and conditional expressions, are never
// associated with template nodes, so their source locations are just a stub.
// Container types like CompoundExpression also don't need a real location.
export const locStub: SourceLocation = {
  source: '',
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 }
}

export function createRoot(
  children: TemplateChildNode[],
  loc = locStub
): RootNode {
  return {
    type: NodeTypes.ROOT,
    children,
    helpers: [],
    components: [],
    directives: [],
    hoists: [],
    imports: [],
    cached: 0,
    temps: 0,
    codegenNode: undefined,
    loc
  }
}

export function createVNodeCall(
  context: TransformContext | null,
  tag: VNodeCall['tag'],
  props?: VNodeCall['props'],
  children?: VNodeCall['children'],
  patchFlag?: VNodeCall['patchFlag'],
  dynamicProps?: VNodeCall['dynamicProps'],
  directives?: VNodeCall['directives'],
  isBlock: VNodeCall['isBlock'] = false,
  disableTracking: VNodeCall['disableTracking'] = false,
  loc = locStub
): VNodeCall {
  if (context) {
    if (isBlock) {
      context.helper(OPEN_BLOCK)
      context.helper(CREATE_BLOCK)
    } else {
      context.helper(CREATE_VNODE)
    }
    if (directives) {
      context.helper(WITH_DIRECTIVES)
    }
  }

  return {
    type: NodeTypes.VNODE_CALL,
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    disableTracking,
    loc
  }
}

export function createArrayExpression(
  elements: ArrayExpression['elements'],
  loc: SourceLocation = locStub
): ArrayExpression {
  return {
    type: NodeTypes.JS_ARRAY_EXPRESSION,
    loc,
    elements
  }
}

export function createObjectExpression(
  properties: ObjectExpression['properties'],
  loc: SourceLocation = locStub
): ObjectExpression {
  return {
    type: NodeTypes.JS_OBJECT_EXPRESSION,
    loc,
    properties
  }
}

export function createObjectProperty(
  key: Property['key'] | string,
  value: Property['value']
): Property {
  return {
    type: NodeTypes.JS_PROPERTY,
    loc: locStub,
    key: isString(key) ? createSimpleExpression(key, true) : key,
    value
  }
}

export function createSimpleExpression(
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'],
  loc: SourceLocation = locStub,
  isConstant: boolean = false
): SimpleExpressionNode {
  return {
    type: NodeTypes.SIMPLE_EXPRESSION,
    loc,
    isConstant,
    content,
    isStatic
  }
}

export function createInterpolation(
  content: InterpolationNode['content'] | string,
  loc: SourceLocation
): InterpolationNode {
  return {
    type: NodeTypes.INTERPOLATION,
    loc,
    content: isString(content)
      ? createSimpleExpression(content, false, loc)
      : content
  }
}

export function createCompoundExpression(
  children: CompoundExpressionNode['children'],
  loc: SourceLocation = locStub
): CompoundExpressionNode {
  return {
    type: NodeTypes.COMPOUND_EXPRESSION,
    loc,
    children
  }
}

type InferCodegenNodeType<T> = T extends typeof RENDER_SLOT
  ? RenderSlotCall
  : CallExpression

export function createCallExpression<T extends CallExpression['callee']>(
  callee: T,
  args: CallExpression['arguments'] = [],
  loc: SourceLocation = locStub
): InferCodegenNodeType<T> {
  return {
    type: NodeTypes.JS_CALL_EXPRESSION,
    loc,
    callee,
    arguments: args
  } as any
}

export function createFunctionExpression(
  params: FunctionExpression['params'],
  returns: FunctionExpression['returns'] = undefined,
  newline: boolean = false,
  isSlot: boolean = false,
  loc: SourceLocation = locStub
): FunctionExpression {
  return {
    type: NodeTypes.JS_FUNCTION_EXPRESSION,
    params,
    returns,
    newline,
    isSlot,
    loc
  }
}

export function createConditionalExpression(
  test: ConditionalExpression['test'],
  consequent: ConditionalExpression['consequent'],
  alternate: ConditionalExpression['alternate'],
  newline = true
): ConditionalExpression {
  return {
    type: NodeTypes.JS_CONDITIONAL_EXPRESSION,
    test,
    consequent,
    alternate,
    newline,
    loc: locStub
  }
}

export function createCacheExpression(
  index: number,
  value: JSChildNode,
  isVNode: boolean = false
): CacheExpression {
  return {
    type: NodeTypes.JS_CACHE_EXPRESSION,
    index,
    value,
    isVNode,
    loc: locStub
  }
}

export function createBlockStatement(
  body: BlockStatement['body']
): BlockStatement {
  return {
    type: NodeTypes.JS_BLOCK_STATEMENT,
    body,
    loc: locStub
  }
}

export function createTemplateLiteral(
  elements: TemplateLiteral['elements']
): TemplateLiteral {
  return {
    type: NodeTypes.JS_TEMPLATE_LITERAL,
    elements,
    loc: locStub
  }
}

export function createIfStatement(
  test: IfStatement['test'],
  consequent: IfStatement['consequent'],
  alternate?: IfStatement['alternate']
): IfStatement {
  return {
    type: NodeTypes.JS_IF_STATEMENT,
    test,
    consequent,
    alternate,
    loc: locStub
  }
}

export function createAssignmentExpression(
  left: AssignmentExpression['left'],
  right: AssignmentExpression['right']
): AssignmentExpression {
  return {
    type: NodeTypes.JS_ASSIGNMENT_EXPRESSION,
    left,
    right,
    loc: locStub
  }
}

export function createSequenceExpression(
  expressions: SequenceExpression['expressions']
): SequenceExpression {
  return {
    type: NodeTypes.JS_SEQUENCE_EXPRESSION,
    expressions,
    loc: locStub
  }
}

export function createReturnStatement(
  returns: ReturnStatement['returns']
): ReturnStatement {
  return {
    type: NodeTypes.JS_RETURN_STATEMENT,
    returns,
    loc: locStub
  }
}
