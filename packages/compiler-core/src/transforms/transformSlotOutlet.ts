import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  CallExpression,
  createCallExpression,
  ExpressionNode,
  SlotOutletNode,
  createFunctionExpression
} from '../ast'
import { isSlotOutlet, findProp } from '../utils'
import { buildProps, PropsExpression } from './transformElement'
import { createCompilerError, ErrorCodes } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'

// 处理<slot>插槽
export const transformSlotOutlet: NodeTransform = (node, context) => {
  if (isSlotOutlet(node)) {
    const { children, loc } = node
    const { slotName, slotProps } = processSlotOutlet(node, context)

    const slotArgs: CallExpression['arguments'] = [
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`,
      slotName
    ]

    if (slotProps) {
      slotArgs.push(slotProps)
    }

    if (children.length) {
      if (!slotProps) {
        slotArgs.push(`{}`)
      }
      slotArgs.push(createFunctionExpression([], children, false, false, loc))
    }

    node.codegenNode = createCallExpression(
      context.helper(RENDER_SLOT),
      slotArgs,
      loc
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext
): SlotOutletProcessResult {
  // slot标签上name特性的值
  let slotName: string | ExpressionNode = `"default"`
  let slotProps: PropsExpression | undefined = undefined

  // check for <slot name="xxx" OR :name="xxx" />
  const name = findProp(node, 'name')
  if (name) {
    if (name.type === NodeTypes.ATTRIBUTE && name.value) {
      // static name
      slotName = JSON.stringify(name.value.content)
    } else if (name.type === NodeTypes.DIRECTIVE && name.exp) {
      // dynamic name
      slotName = name.exp
    }
  }

  // 没有name特性的node节点上的特性列表
  const propsWithoutName = name
    ? node.props.filter(p => p !== name)
    : node.props
  if (propsWithoutName.length > 0) {
    // 将节点类型的props转换为表达式类型的props
    // Todo 表达式类型的props应该适用于在生成render时使用吧
    const { props, directives } = buildProps(node, context, propsWithoutName)
    slotProps = props
    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc
        )
      )
    }
  }

  return {
    slotName,
    slotProps
  }
}
