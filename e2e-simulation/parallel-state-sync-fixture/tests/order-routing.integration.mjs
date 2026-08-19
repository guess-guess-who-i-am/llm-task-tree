import assert from "node:assert/strict";
import { isEligibleOrder } from "../business/eligibility.mjs";
import { fulfillmentPriority } from "../business/priority.mjs";

const orders = [
  { id: "order-enterprise", region: "east", itemCount: 3, customerTier: "enterprise", expedited: false },
  { id: "order-expedited", region: "north", itemCount: 1, customerTier: "standard", expedited: true },
  { id: "order-standard", region: "east", itemCount: 2, customerTier: "standard", expedited: false },
  { id: "order-unsupported", region: "west", itemCount: 2, customerTier: "enterprise", expedited: false }
];

const routed = orders
  .filter(isEligibleOrder)
  .sort((left, right) => fulfillmentPriority(left) - fulfillmentPriority(right))
  .map((order) => order.id);

assert.deepEqual(routed, ["order-enterprise", "order-expedited", "order-standard"]);
assert.equal(isEligibleOrder({ id: "order-empty", region: "east", itemCount: 0 }), false);
assert.equal(fulfillmentPriority(orders[0]), 1);
assert.equal(fulfillmentPriority(orders[1]), 2);

console.log(JSON.stringify({
  status: "passed",
  assertions: 4,
  routedOrderIds: routed,
  networkUsed: false,
  browserUsed: false,
  humanInputUsed: false
}));
