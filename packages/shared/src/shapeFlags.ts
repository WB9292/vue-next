export const enum ShapeFlags {
  ELEMENT = 1,
  FUNCTIONAL_COMPONENT = 1 << 1,
  STATEFUL_COMPONENT = 1 << 2,
  // vnode的文本类型的子元素
  TEXT_CHILDREN = 1 << 3,
  // vnode的数组类型的子元素
  ARRAY_CHILDREN = 1 << 4,
  // vnode的插槽类型的子元素
  SLOTS_CHILDREN = 1 << 5,
  TELEPORT = 1 << 6,
  // 3.x支持的suspense组件
  SUSPENSE = 1 << 7,
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8,
  COMPONENT_KEPT_ALIVE = 1 << 9,
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT
}
