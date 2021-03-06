import { ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import { ErrorCodes, createCompilerError, defaultOnError } from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot
} from './ast'

type OptionalOptions = 'isNativeTag' | 'isBuiltInComponent'
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError,
  comments: false
}

// Todo 文本模式是干嘛的？
export const enum TextModes {
  //          | Elements | Entities（是否处理内部的内容） | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea> // 不生成元素，处理内部的内容
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script> // 不生成元素，也不处理内部的内容
  CDATA, // Todo 这个模式先不必细究
  ATTRIBUTE_VALUE// Todo 与正常流程关系不大，无需细究
}

/**
 * 以"<div>\nhello</div>"为例，解释这些字段的含义：
 * 一开始解析时，originalSource和source都是"<div>\nhello</div>"，offset为0，指向待编译的第一个字符，line为1，column为1，
 * 假设接下来"<div>\n"处理完成，则originalSource保持不变，source变为"hello</div>"，offset变为6，指向"h"字符的位置，注意"\n"是换行符，
 * line为2，因为换行了，而column仍然为1，也就是说，column指向当前正在处理的那一行的偏移量
 */
export interface ParserContext {
  // 将默认编译器选项对象defaultParserOptions与外部传入的选项对象进行合并后的选项对象
  options: MergedParserOptions
  // 原始待编译字符串
  readonly originalSource: string
  // 剩余待编译的字符串，在编译过程中会将处理完成的字符删除，只保留未处理的字符
  source: string
  // 当前正在处理的字符相对于原始字符串originalSource的偏移量，从0开始计数
  offset: number
  // 当前处理的相对于原始待编译字符的行数，以1开始计数
  line: number
  // line所指向的行的偏移量，以1开始计数
  column: number
  // 是否是<pre>标签
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  // 是否是v-pre指令
  inVPre: boolean // v-pre, do not process directives and interpolations
}

export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  const context = createParserContext(content, options)
  const start = getCursor(context)
  return createRoot(
    parseChildren(context, TextModes.DATA, []),
    getSelection(context, start)
  )
}

function createParserContext(
  content: string,
  rawOptions: ParserOptions
): ParserContext {
  const options = extend({}, defaultParserOptions)
  for (const key in rawOptions) {
    // @ts-ignore
    options[key] = rawOptions[key] || defaultParserOptions[key]
  }
  return {
    options,
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content,
    source: content,
    inPre: false,
    inVPre: false
  }
}

function parseChildren(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  // 获取ancestors中的最后一个元素
  // parent是什么？答：当前待解析子元素的直接父元素
  const parent = last(ancestors)
  // Todo 不知道ns在整个系统中的具体作用是什么
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // 从代码中看，正常情况下，有六种类型的子元素
    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      // delimiters默认是[`{{`, `}}`]，表示文本插值
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) { // ①插值运算符子元素
        // '{{'
        node = parseInterpolation(context, mode)
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') { // Todo 这个分支的代码暂不研究
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) { // ②注释子元素
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) { // ③DOCTYPE子元素
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) { // ④CDATA子元素
            if (ns !== Namespaces.HTML) {
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else {
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') {
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) {
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') {
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) { // 这不应该是结束标签吗？为什么要抛出错误？答：在parseElement()方法中，已经解析过结束标签了，所以不会再有结束标签存在，详情可查看parseElement()方法，这里是模板字符串有错误
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            parseTag(context, TagType.End, parent)
            continue
          } else {
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) { // ⑤元素节点子元素
          node = parseElement(context, ancestors)
        } else if (s[1] === '?') {
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else {
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1) // 正如INVALID_FIRST_CHARACTER_OF_TAG_NAME错误文案所述，如果希望使用"<"，可使用"&lt;"代替
        }
      }
    }
    if (!node) {
      node = parseText(context, mode) // ⑥纯文本子元素
    }

    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i])
      }
    } else {
      pushNode(nodes, node)
    }
  }

  // Whitespace management for more efficient output
  // (same as v2 whitespace: 'condense')
  // 由于某些节点（连续空白符、注释等）会删除，该变量用于标识，是否存在被删除的节点
  let removedWhitespace = false
  if (mode !== TextModes.RAWTEXT) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!context.inPre && node.type === NodeTypes.TEXT) {
        // [^\t\r\n\f ]的意思是：在node.content中，只要有一个字符不是'\t\r\n\f '，就返回true
        // 所以整个条件的含义是，node.content中只有'\t\r\n\f '这种类型的字符
        // 这种类型的字符串是在哪里收集的？答：就像下面的If提到的，这几种情况下就会产生这种只有空白符的字符串
        if (!/[^\t\r\n\f ]/.test(node.content)) {
          const prev = nodes[i - 1]
          const next = nodes[i + 1]
          // If:
          // - the whitespace is the first or last node, or: 如果空格是第一个或最后一个节点
          // - the whitespace is adjacent to a comment, or: 如果空格与注释相邻
          // - the whitespace is between two elements AND contains newline 在两个元素之间的空白符，并且有换行符。 // Todo 这里的处理有点问题，如果是两个内联元素，并且换行，则两个元素之间的不会有空白，但是其实应该是有空白的，有些地方确实不太好处理
          // Then the whitespace is ignored.
          if (
            !prev ||
            !next ||
            prev.type === NodeTypes.COMMENT ||
            next.type === NodeTypes.COMMENT ||
            (prev.type === NodeTypes.ELEMENT &&
              next.type === NodeTypes.ELEMENT &&
              /[\r\n]/.test(node.content))
          ) {
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // Otherwise, condensed consecutive whitespace inside the text
            // down to a single space
            node.content = ' '
          }
        } else {
          // 将文本中的多个连续空白符替换为单个空格
          node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
        }
      }
      // also remove comment nodes in prod by default
      if (
        !__DEV__ &&
        node.type === NodeTypes.COMMENT &&
        !context.options.comments
      ) {
        removedWhitespace = true
        nodes[i] = null as any
      }
    }
    if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  const wasInPre = context.inPre
  const wasInVPre = context.inVPre
  // 最近的祖先元素，也就是直接父元素
  const parent = last(ancestors)

  const element = parseTag(context, TagType.Start, parent)
  /**
   * 是否是pre标签的边界，pre标签中可能嵌套pre标签，比如：
   * <pre>
   *   <div>
   *      <pre>hello</pre>
   *   </div>
   * </pre>
   * 这里的isPreBoundary指的是最外层的pre标签
   */
  const isPreBoundary = context.inPre && !wasInPre
  // 这个变量的含义与isPreBoundary类似，只是针对v-pre指令
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 如果是自关闭（比如<img />）或者可以为空的标签，则直接返回元素
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  ancestors.push(element)
  // Todo 文本模式的作用是什么？
  const mode = context.options.getTextMode(element, parent)
  const children = parseChildren(context, mode, ancestors)
  ancestors.pop()

  element.children = children

  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    // 解析结束标签时，并没有保存parseTag的结果，而是直接丢弃，这里只是为了校验结束标签是否有错误，比如是否有属性等
    parseTag(context, TagType.End, parent)
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)

  if (isPreBoundary) {
    // 已出了<pre>标签的范围
    context.inPre = false
  }
  if (isVPreBoundary) {
    // 已出了v-pre指令的范围
    context.inVPre = false
  }
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  // 标签的开始位置
  const start = getCursor(context)
  // 匹配标签名，可以用于匹配开始标签或结束标签，比如：
  // '<div class="test"></div>'的结果为['<div', 'div']
  // 不仅可以匹配开始标签，还可以匹配结束标签
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  // 标签名
  const tag = match[1]
  // getNamespace方法在compiler-dom/src/parserOptions.ts中
  const ns = context.options.getNamespace(tag, parent)

  advanceBy(context, match[0].length)
  // 跳过开头的空白符
  advanceSpaces(context)

  // save current state in case we need to re-parse attributes with v-pre
  const cursor = getCursor(context)
  const currentSource = context.source

  // Attributes.
  let props = parseAttributes(context, type)

  // check <pre> tag
  // <pre>与v-pre的处理方式不同，v-pre会完全保留对应标签、属性及其内部的形式
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // check v-pre
  // v-pre指令会完全保留对应标签、属性及其内部的形式
  if (
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    context.inVPre = true
    // reset context
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 跳过标签结尾的">"或"/>"，至此，开始标签/结束标签全部解析完成
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  // 接下来是确定元素节点的类型
  let tagType = ElementTypes.ELEMENT
  const options = context.options
  if (!context.inVPre && !options.isCustomElement(tag)) {
    // 是否有v-is指令
    const hasVIs = props.some(
      p => p.type === NodeTypes.DIRECTIVE && p.name === 'is'
    )
    if (options.isNativeTag && !hasVIs) {
      // 默认情况下，isNativeTag方法判断是否是原生html标签，compiler-dom/src/parserOptions.ts文件下
      // 所，只要不是原生html标签，就算作组件
      if (!options.isNativeTag(tag)) tagType = ElementTypes.COMPONENT
    } else if (
      hasVIs ||
      isCoreComponent(tag) ||
      (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
      /^[A-Z]/.test(tag) || // 首字母大写的标签认为是组件
      tag === 'component'
    ) {
      tagType = ElementTypes.COMPONENT
    }

    if (tag === 'slot') {
      tagType = ElementTypes.SLOT
    } else if (
      tag === 'template' &&
      props.some(p => {
        return (
          p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name) // 如果template标签上没有v-if，v-else等指令，则template就是html原生标签
        )
      })
    ) {
      tagType = ElementTypes.TEMPLATE
    }
  }

  return {
    // 节点的类型
    type: NodeTypes.ELEMENT,
    ns,
    // 标签名
    tag,
    // 元素的类型
    tagType,
    // 标签上的特性
    props,
    // 是否是自关闭标签，比如 <br />
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

// 解析标签上的特性时，context.source字符串开头的空白符已删除
function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  const attributeNames = new Set<string>()
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    // 结束标签不能有特性
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    const attr = parseAttribute(context, attributeNames)
    if (type === TagType.Start) {
      props.push(attr)
    }

    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    advanceSpaces(context)
  }
  return props
}

/**
 * 解析单个特性
 * 如果返回的是AttributeNode类型的值，则是纯粹的特性，v- : @等都是指令节点
 * @param context
 * @param nameSet
 */
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode { // 特性只有两种类型：普通特性和指令特性
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  // start是特性名的开始位置信息，
  const start = getCursor(context)
  // 解析特性名
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  // 特性名
  const name = match[0]

  if (nameSet.has(name)) { // 同一特性多次出现，给出警告
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  nameSet.add(name)

  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }

  {
    // 特性名中不能存在"'<
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  advanceBy(context, name.length)

  // Value
  let value:
    | {
        content: string
        isQuoted: boolean
        loc: SourceLocation
      }
    | undefined = undefined

  // source是否以等号开始（等号之前可能存在空白符）
  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    // 跳过空白符
    advanceSpaces(context)
    // 跳过等号
    advanceBy(context, 1)
    // 跳过等号之后，特性值之前的空白符
    advanceSpaces(context)
    // 特性值
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  // 当前整个特性的位置信息，比如：'<div name="test" class="go"></div>'中，当解析name特性时，loc指向的是整个name="test"的位置信息
  const loc = getSelection(context, start)

  // #号应该是指具名插槽的缩写：https://cn.vuejs.org/v2/guide/components-slots.html#%E5%85%B7%E5%90%8D%E6%8F%92%E6%A7%BD%E7%9A%84%E7%BC%A9%E5%86%99
  // context.inVPre为表示v-pre指令，v-pre指令保留内容
  if (!context.inVPre && /^(v-|:|@|#)/.test(name)) { // 处理指令的特性名
    // 第一个分组([a-z0-9-]+)：匹配指令名，由正则可知，指令名只能包含小写字母或者数字
    // 第二个分组(\[[^\]]+\]|[^\.]+)：
    /**
     * 分为两部分讨论：
     * 1）\[[^\]]+\]应该是匹配vue的动态参数，文档：https://cn.vuejs.org/v2/guide/syntax.html#%E5%8A%A8%E6%80%81%E5%8F%82%E6%95%B0
     * 2）[^\.]+：匹配非.
     * 综上所述：匹配指令参数
     */
    // 第三个分组(.+)：匹配修饰符
    /**
     * 例子：
     * 1）name='v-hello:go.one.two'
     * ["v-hello:go.one.two", "hello", "go", ".one.two"]
     * 2）name='v-hello:[go].one.two'
     * ["v-hello:[go].one.two", "hello", "[go]", ".one.two"]
     */
    // 具体看一下vue的自定义指令应该就可以明白了：https://cn.vuejs.org/v2/guide/custom-directive.html
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
      name
    )!

    // 指令名
    const dirName =
      match[1] ||
      (startsWith(name, ':') ? 'bind' : startsWith(name, '@') ? 'on' : 'slot')

    let arg: ExpressionNode | undefined

    if (match[2]) { // 处理指令参数
      // 是否是v-slot
      const isSlot = dirName === 'slot'
      // 指令参数的开始位置
      const startOffset = name.indexOf(match[2])
      const loc = getSelection(
        context,
        // 将start前进startOffset步，也就是该函数返回的新位置对象相对于原始待编译字符串，其指向指令参数的开始位置
        getNewPosition(context, start, startOffset),
        // 对于插槽，是前进到整个特性名的结束位置。对于其他指令，是前进到指令参数的结束位置
        getNewPosition(
          context,
          start,
          // 插槽特殊处理的原因：个人理解的是，插槽没有匹配修饰符，所以#或v-slot:之后的所有内容都属于插槽
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      // 指令参数
      let content = match[2]
      let isStatic = true

      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }

        // '[name]' --> 'name'
        content = content.substr(1, content.length - 2)
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        // 插槽不支持修饰符，直接作为指令参数的一部分
        content += match[3] || ''
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        // 指令参数的内容
        content,
        // false表示是动态指令参数
        isStatic,
        isConstant: isStatic,
        loc
      }
    }

    // 为什么要这么处理？答：因为如果存在引号，则value.loc.source的值中存在引号，比如'"hello"'这样，所以需要将引号删除
    if (value && value.isQuoted) { // isQuoted表示值以单引号或双引号包裹
      const valueLoc = value.loc
      // start开始位置前进一步，跳过开头的引号
      valueLoc.start.offset++
      valueLoc.start.column++
      // end回退一步
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    return {
      type: NodeTypes.DIRECTIVE,
      name: dirName,
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        // Treat as non-constant by default. This can be potentially set to
        // true by `transformExpression` to make it eligible for hoisting.
        isConstant: false,
        loc: value.loc
      },
      arg,
      modifiers: match[3] ? match[3].substr(1).split('.') : [],
      loc
    }
  }

  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(
  context: ParserContext
):
  | {
      content: string // 特性值的内容
      isQuoted: boolean // 特性值是否使用引号包裹
      loc: SourceLocation // 特性值的文本的位置信息
    }
  | undefined {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) { // 特性值由引号包裹
    // Quoted value.
    // 跳过开头的引号
    advanceBy(context, 1)

    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) { // Todo 这应该是一个不正常的情况，无需细究
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      // 跳过结尾的引号
      advanceBy(context, 1)
    }
  } else { // 特性值无引号包裹
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  return { content, isQuoted, loc: getSelection(context, start) }
}

function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __TEST__ && assert(startsWith(context.source, open))

  // 最近的关闭分隔符在context.source中的开始位置
  const closeIndex = context.source.indexOf(close, open.length)
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  // 文本插值的开始分隔符的位置信息
  const start = getCursor(context)
  advanceBy(context, open.length)
  // 文本插值的内容的开始位置，比如"{{hello}}"，指向"h"的位置
  const innerStart = getCursor(context)
  // 文本插值的内容的结束位置，默认指向开始位置
  const innerEnd = getCursor(context)
  // 文本插值的内容的长度，比如"{{hello}}"，为5，也就是"hello"的长度
  const rawContentLength = closeIndex - open.length
  // 文本插值的内容
  const rawContent = context.source.slice(0, rawContentLength)
  // 获取rawContent转义后的内容（如果其内部有html转义字符），并更新context中的位置，指向文本插值的关闭分隔符的开始位置
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  const content = preTrimContent.trim()
  const startOffset = preTrimContent.indexOf(content)
  if (startOffset > 0) { // startOffset > 0成立时，说明preTrimContent字符串的开头有空白字符
    // 更新innerStart，跳过开头空白字符的位置
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  // preTrimContent.length - content.length - startOffset表示preTrimContent字符串中结尾的空白字符的长度
  // endOffset表示rawContent中最后结尾第一个空字符的偏移量，比如"{{ hello }}，指向"}}"前面的空字符
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  // 更新innerEnd，指向rawContent的最后结尾第一个空字符的位置，比如"{{ hello }}，指向"}}"前面的空字符
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  // 更新编译器上下文对象中的位置，跳过关闭分隔符
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      // Set `isConstant` to false by default and will decide in transformExpression
      isConstant: false,
      content,
      // 文本插值的内容在原始待编译字符串的位置信息
      loc: getSelection(context, innerStart, innerEnd)
    },
    // 包含开始和结束分隔符的整个文本插值在原始待编译字符串的位置信息
    loc: getSelection(context, start)
  }
}

function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  const endTokens = ['<', context.options.delimiters[0]]
  if (mode === TextModes.CDATA) {
    endTokens.push(']]>')
  }

  // endIndex指向可能存在的"<"或"{{"的位置，只解析endIndex之前的纯文本，"<"可能是标签、注释等，"{{"可能是插值运算符
  let endIndex = context.source.length
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    // 什么情况下endIndex > index不成立？
    // 答：这里是寻找source中离开始最近的'<'或'{{'，比如："hello<div>{{test}}</div>"，这里寻找的是"<"下标位置，而不是"{{"，
    // 对于该字符串，第一次循环，endIndex=24，index=5，第二次循环，endIndex=5，index=10，此时保留5而不更新为10
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  const start = getCursor(context)
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  const rawText = context.source.slice(0, length)
  advanceBy(context, length)
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    rawText.indexOf('&') === -1 // Todo 猜测，这里应该是处理html转义，比如"&#60;" --> "<"，"&#62;" --> ">"
  ) {
    return rawText
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    // 将rawText中可能存在的转义字符转换为其对应的真正的字符，比如"&#60;" --> "<"，"&#62;" --> ">"
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

// Selection是选中的区域，由start和end指定的区域
// 这个区域把start和end都包含在内吗？还是不包含end？答：不包含end，[start, end)
function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

/**
 * 解析字符串时，前进numberOfCharacters数目的字符，主要是更新上下文对象中的offset，line，column和source属性
 * @param context
 * @param numberOfCharacters
 */
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  advancePositionWithMutation(context, source, numberOfCharacters)
  // 更新source属性
  context.source = source.slice(numberOfCharacters)
}

// 跳过当前context.source开头的空白符
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

/**
 * 该方法用于根据context.source属性，将start前进numberOfCharacters步
 * @param context
 * @param start
 * @param numberOfCharacters
 */
function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  const s = context.source

  switch (mode) {
    case TextModes.DATA:
      // 是否以结束标签开始
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) { // 这里要一直循环祖先元素，是为了处理像"<div><span></div></span>"这样嵌套错误的异常情况，符合原生html的处理方法，Todo 可暂不细究
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  return !s
}

function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\r\n\f />]/.test(source[2 + tag.length] || '>') // 标签名之后没有其他字符，也就是说要确定source对应的结束标签就是tag
  )
}
