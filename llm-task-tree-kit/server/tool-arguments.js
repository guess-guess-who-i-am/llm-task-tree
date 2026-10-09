// Runtime checks for the JSON Schema vocabulary used by this dependency-free kit's tools.
// A schema sent to a model is not validation: reject invalid arguments before any side effect.
export function validateToolArguments(schema, value, at = 'arguments') {
  if (schema == null || schema === true) return;
  const invalid = message => { throw new Error(`工具参数错误：${at} ${message}`); };
  if (schema === false) invalid('不被允许');
  const type = schema.type;
  const matches = t => t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value)
    : t === 'null' ? value === null : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t;
  if (type && !(Array.isArray(type) ? type.some(matches) : matches(type))) invalid(`必须是 ${type}`);
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) invalid(`必须选自 ${schema.enum.join('、')}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) invalid(`至少 ${schema.minLength} 个字符`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) invalid(`最多 ${schema.maxLength} 个字符`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(`不符合 ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) invalid(`不能小于 ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) invalid(`不能大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) invalid(`至少 ${schema.minItems} 项`);
    for (let i=0;i<value.length;i++) validateToolArguments(schema.items,value[i],`${at}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value,key)) invalid(`缺少 ${key}`);
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) invalid(`至少 ${schema.minProperties} 个字段`);
    for (const [key,item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validateToolArguments(child,item,`${at}.${key}`);
      else if (schema.additionalProperties === false) invalid(`不支持字段 ${key}；子树路径应传给 task_tree_subtree，不是 task_tree_write`);
      else if (typeof schema.additionalProperties === 'object') validateToolArguments(schema.additionalProperties,item,`${at}.${key}`);
    }
  }
}
