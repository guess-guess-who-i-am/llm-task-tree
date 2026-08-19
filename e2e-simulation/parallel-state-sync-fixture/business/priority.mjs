export function fulfillmentPriority(order) {
  if (order.customerTier === "enterprise") return 1;
  if (order.expedited === true) return 2;
  return 3;
}
