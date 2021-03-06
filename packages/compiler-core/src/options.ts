import { ElementNode, Namespace, TemplateChildNode, ParentNode } from './ast'
import { TextModes } from './parse'
import { CompilerError } from './errors'
import {
  NodeTransform,
  DirectiveTransform,
  TransformContext
} from './transform'
import { ParserPlugin } from '@babel/parser'

export interface ParserOptions {
  /**
   * e.g. platform native elements, e.g. `<div>` for browsers
   */
  isNativeTag?: (tag: string) => boolean
  /**
   * e.g. native elements that can self-close, e.g. `<img>`, `<br>`, `<hr>`
   */
  isVoidTag?: (tag: string) => boolean
  /**
   * e.g. elements that should preserve whitespace inside, e.g. `<pre>`
   * 注意，pre的作用是保留内部的空白符
   */
  isPreTag?: (tag: string) => boolean
  /**
   * Platform-specific built-in components e.g. `<Transition>`
   */
  isBuiltInComponent?: (tag: string) => symbol | void
  /**
   * Separate option for end users to extend the native elements list
   */
  isCustomElement?: (tag: string) => boolean | void
  /**
   * Get tag namespace
   */
  getNamespace?: (tag: string, parent: ElementNode | undefined) => Namespace
  /**
   * Get text parsing mode for this element
   */
  getTextMode?: (
    node: ElementNode,
    parent: ElementNode | undefined
  ) => TextModes
  /**
   * @default ['{{', '}}'] 表示模板字符串中的文本插值的分隔符
   */
  delimiters?: [string, string]
  /**
   * Only needed for DOM compilers
   * 个人理解：依据compiler-dom/src/decodeHtmlBrowser.ts中的源码，可以猜测decodeEntities的作用是对html中的一些字符进行转义，转换为其对应真正的字符，
   * 比如，原始html转义字符为"&#60;"，转换为"<"
   */
  decodeEntities?: (rawText: string, asAttr: boolean) => string
  onError?: (error: CompilerError) => void
  /**
   * Keep comments in the templates AST, even in production
   */
  comments?: boolean
}

export type HoistTransform = (
  children: TemplateChildNode[],
  context: TransformContext,
  parent: ParentNode
) => void

export interface BindingMetadata {
  [key: string]: 'data' | 'props' | 'setup' | 'options'
}

export interface TransformOptions {
  /**
   * An array of node transforms to be applied to every AST node.
   */
  nodeTransforms?: NodeTransform[]
  /**
   * An object of { name: transform } to be applied to every directive attribute
   * node found on element nodes.
   * 正常流程中，各指令转换器的具体位置：
   * v-cloak、v-html、v-text、v-model、v-on、v-show：compiler-dom/src/index.ts --> DOMDirectiveTransforms
   * v-bind：compiler-core/src/compile.ts --> getBaseTransformPreset()
   */
  directiveTransforms?: Record<string, DirectiveTransform | undefined>
  /**
   * An optional hook to transform a node being hoisted.
   * used by compiler-dom to turn hoisted nodes into stringified HTML vnodes.
   * @default null
   */
  transformHoist?: HoistTransform | null
  /**
   * If the pairing runtime provides additional built-in elements, use this to
   * mark them as built-in so the compiler will generate component vnodes
   * for them.
   */
  isBuiltInComponent?: (tag: string) => symbol | void
  /**
   * Used by some transforms that expects only native elements
   */
  isCustomElement?: (tag: string) => boolean | void
  /**
   * Transform expressions like {{ foo }} to `_ctx.foo`.
   * If this option is false, the generated code will be wrapped in a
   * `with (this) { ... }` block.
   * - This is force-enabled in module mode, since modules are by default strict
   * and cannot use `with`
   * @default mode === 'module'
   */
  prefixIdentifiers?: boolean
  /**
   * Hoist static VNodes and props objects to `_hoisted_x` constants
   * @default false
   */
  hoistStatic?: boolean
  /**
   * Cache v-on handlers to avoid creating new inline functions on each render,
   * also avoids the need for dynamically patching the handlers by wrapping it.
   * e.g `@click="foo"` by default is compiled to `{ onClick: foo }`. With this
   * option it's compiled to:
   * ```js
   * { onClick: _cache[0] || (_cache[0] = e => _ctx.foo(e)) }
   * ```
   * - Requires "prefixIdentifiers" to be enabled because it relies on scope
   * analysis to determine if a handler is safe to cache.
   * @default false
   */
  cacheHandlers?: boolean
  /**
   * A list of parser plugins to enable for `@babel/parser`, which is used to
   * parse expressions in bindings and interpolations.
   * https://babeljs.io/docs/en/next/babel-parser#plugins
   */
  expressionPlugins?: ParserPlugin[]
  /**
   * SFC scoped styles ID
   */
  scopeId?: string | null
  /**
   * Generate SSR-optimized render functions instead.
   * The resulting function must be attached to the component via the
   * `ssrRender` option instead of `render`.
   */
  ssr?: boolean
  /**
   * SFC `<style vars>` injection string
   * needed to render inline CSS variables on component root
   */
  ssrCssVars?: string
  /**
   * Optional binding metadata analyzed from script - used to optimize
   * binding access when `prefixIdentifiers` is enabled.
   */
  bindingMetadata?: BindingMetadata
  onError?: (error: CompilerError) => void
}

export interface CodegenOptions {
  /**
   * - `module` mode will generate ES module import statements for helpers
   * and export the render function as the default export.
   * - `function` mode will generate a single `const { helpers... } = Vue`
   * statement and return the render function. It expects `Vue` to be globally
   * available (or passed by wrapping the code with an IIFE). It is meant to be
   * used with `new Function(code)()` to generate a render function at runtime.
   * @default 'function'
   */
  mode?: 'module' | 'function'
  /**
   * Generate source map?
   * @default false
   */
  sourceMap?: boolean
  /**
   * Filename for source map generation.
   * @default 'template.vue.html'
   */
  filename?: string
  /**
   * SFC scoped styles ID
   */
  scopeId?: string | null
  /**
   * Option to optimize helper import bindings via variable assignment
   * (only used for webpack code-split)
   * @default false
   */
  optimizeImports?: boolean
  /**
   * Customize where to import runtime helpers from.
   * @default 'vue'
   */
  runtimeModuleName?: string
  /**
   * Customize the global variable name of `Vue` to get helpers from
   * in function mode
   * @default 'Vue'
   */
  runtimeGlobalName?: string
  // we need to know this during codegen to generate proper preambles
  prefixIdentifiers?: boolean
  bindingMetadata?: BindingMetadata
  // generate ssr-specific code?
  ssr?: boolean
}

export type CompilerOptions = ParserOptions & TransformOptions & CodegenOptions
