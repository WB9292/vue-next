import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { ElementNode, ForNode, IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

export const transformOnce: NodeTransform = (node, context) => {
  // 判断节点上是否存在v-one指令
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    /**
     * Todo 一个节点什么情况下会处理多次？
     * 猜测：<div v-once v-if="test">hello</div>的情况下会处理多次，
     * 由compiler-core/src/compile.ts --> getBaseTransformPreset()方法可知，先处理v-once指令，再处理v-if指令
     * 此时，就会处理两次v-once，可结合compiler-core/src/transforms/vIf.ts中的处理逻辑来思考
     */
    if (seen.has(node)) {
      return
    }
    seen.add(node)
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) {
        cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */)
      }
    }
  }
}
