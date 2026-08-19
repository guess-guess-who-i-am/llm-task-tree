const supportedRegions = new Set(["east", "north"]);

export function isEligibleOrder(order) {
  return Boolean(
    order
    && typeof order.id === "string"
    && order.id.length > 0
    && Number.isInteger(order.itemCount)
    && order.itemCount > 0
    && supportedRegions.has(order.region)
  );
}
