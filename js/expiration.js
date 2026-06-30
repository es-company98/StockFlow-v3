import { Timestamp, db, doc, updateDoc, serverTimestamp } from "./firebase.js";

export function isExpirationEnabled(config) {
  return config?.enableExpiration === true;
}

export function toExpirationTimestamp(dateStr) {
  if (!dateStr) return null;

  const parts = String(dateStr).split("-");
  if (parts.length !== 3) return null;

  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const day = Number(parts[2]);

  const date = new Date(year, month, day, 23, 59, 59, 999);
  if (isNaN(date.getTime())) return null;

  return Timestamp.fromDate(date);
}

export function expirationToDate(value) {
  if (!value) return null;

  if (typeof value?.toDate === "function") {
    return value.toDate();
  }

  if (value?.seconds) {
    return new Date(value.seconds * 1000);
  }

  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isLotExpired(expirationDate, asOfDate = new Date()) {
  if (!expirationDate) return false;

  const exp = expirationToDate(expirationDate);
  if (!exp) return false;

  return startOfDay(exp).getTime() < startOfDay(asOfDate).getTime();
}

export function getDaysUntilExpiration(expirationDate, asOfDate = new Date()) {
  const exp = expirationToDate(expirationDate);
  if (!exp) return null;

  const diff =
    startOfDay(exp).getTime() - startOfDay(asOfDate).getTime();

  return Math.ceil(diff / 86400000);
}

export function getExpirationBadgeStyle(daysLeft, alertDays = 30) {
  if (daysLeft === null || daysLeft === undefined) {
    return null;
  }

  if (daysLeft <= 0) {
    return {
      backgroundColor: "#FEE2E2",
      color: "#991B1B",
      label: "Expiré"
    };
  }

  const maxDays = Math.max(1, Number(alertDays) || 30);
  const ratio = Math.min(1, daysLeft / maxDays);
  const hue = Math.round(ratio * 120);

  return {
    backgroundColor: `hsl(${hue}, 65%, 92%)`,
    color: `hsl(${hue}, 55%, 28%)`,
    label: daysLeft === 1 ? "1 j" : `${daysLeft} j`
  };
}

export function getSellableLots(movements, productId, asOfDate = new Date()) {
  return computeLotBalances(movements, productId)
    .filter(lot => !isLotExpired(lot.expirationDate, asOfDate))
    .sort(compareLots);
}

export function getSellableQty(movements, productId, asOfDate = new Date()) {
  return getSellableLots(movements, productId, asOfDate)
    .reduce((sum, lot) => sum + lot.remaining, 0);
}

export function getProductExpirationDisplay(
  product,
  movements,
  options = {}
) {
  const {
    alertDays = 30,
    asOfDate = new Date()
  } = options;

  if (!product?.hasExpiration) return null;

  const productId = product.id || product.productId;
  const sellableLots = getSellableLots(movements, productId, asOfDate);
  const allLots = computeLotBalances(movements, productId)
    .filter(lot => lot.expirationDate)
    .sort(compareLots);

  const sellableQty = sellableLots.reduce(
    (sum, lot) => sum + lot.remaining,
    0
  );

  const displayLot = sellableLots[0] || allLots[0];
  if (!displayLot?.expirationDate) return null;

  const daysLeft = getDaysUntilExpiration(
    displayLot.expirationDate,
    asOfDate
  );

  const style = getExpirationBadgeStyle(daysLeft, alertDays);

  return {
    daysLeft,
    sellableQty,
    expired: sellableQty <= 0,
    style
  };
}

export function formatExpirationDate(value) {
  const date = expirationToDate(value);
  if (!date) return "-";
  return date.toLocaleDateString("fr-FR");
}

function movementTime(movement) {
  const date = expirationToDate(movement?.createdAt);
  return date ? date.getTime() : 0;
}

function compareLots(a, b) {
  const dateA = expirationToDate(a.expirationDate);
  const dateB = expirationToDate(b.expirationDate);

  if (dateA && dateB && dateA.getTime() !== dateB.getTime()) {
    return dateA.getTime() - dateB.getTime();
  }

  if (dateA && !dateB) return -1;
  if (!dateA && dateB) return 1;

  return movementTime(a) - movementTime(b);
}

export function filterProductMovements(movements, productId) {
  return (movements || []).filter(
    movement => movement?.productId === productId
  );
}

export function computeLotBalances(movements, productId = null) {
  const scoped = productId
    ? filterProductMovements(movements, productId)
    : (movements || []);

  const sorted = [...scoped].sort(
    (a, b) => movementTime(a) - movementTime(b)
  );

  const lots = [];

  sorted.forEach(movement => {
    const qty = Number(movement?.quantity) || 0;
    if (qty <= 0) return;

    if (movement.type === "IN") {
      lots.push({
        movementId: movement.id || null,
        qty,
        remaining: qty,
        expirationDate: movement.expirationDate || null,
        batchId: movement.batchId || null,
        createdAt: movement.createdAt || null
      });
      return;
    }

    if (movement.type !== "OUT") return;

    let remainingOut = qty;

    for (const lot of lots) {
      if (remainingOut <= 0) break;
      if (lot.remaining <= 0) continue;

      const used = Math.min(lot.remaining, remainingOut);
      lot.remaining -= used;
      remainingOut -= used;
    }
  });

  return lots.filter(lot => lot.remaining > 0);
}

export function allocateFifo(
  productId,
  qty,
  movements,
  options = {}
) {
  const {
    excludeExpired = false,
    asOfDate = new Date()
  } = options;

  const requestedQty = Number(qty) || 0;
  if (requestedQty <= 0) return [];

  const allLots = computeLotBalances(movements, productId)
    .sort(compareLots);

  const lots = excludeExpired
    ? allLots.filter(lot => !isLotExpired(lot.expirationDate, asOfDate))
    : allLots;

  const totalAvailable = lots.reduce(
    (sum, lot) => sum + lot.remaining,
    0
  );

  if (totalAvailable < requestedQty) {
    const totalAll = allLots.reduce(
      (sum, lot) => sum + lot.remaining,
      0
    );

    if (
      excludeExpired &&
      totalAll >= requestedQty &&
      totalAll > totalAvailable
    ) {
      throw new Error(
        "Stock expiré — vente impossible. Retirez le lot via Pertes."
      );
    }

    throw new Error("Stock insuffisant pour allocation FIFO");
  }

  let remaining = requestedQty;
  const allocations = [];

  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.remaining <= 0) continue;

    const take = Math.min(lot.remaining, remaining);

    allocations.push({
      qty: take,
      expirationDate: lot.expirationDate || null,
      batchId: lot.batchId || null
    });

    remaining -= take;
  }

  return allocations;
}

export function getNearestExpiration(movements, productId) {
  const lots = computeLotBalances(movements, productId)
    .filter(lot => lot.expirationDate)
    .sort(compareLots);

  if (!lots.length) return null;

  return lots[0].expirationDate;
}

export function getExpiringAlerts(products, movements, alertDays = 30) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const alertLimit = new Date(now);
  alertLimit.setDate(alertLimit.getDate() + Math.max(1, Number(alertDays) || 30));

  let expiringSoonCount = 0;
  let expiredCount = 0;

  (products || []).forEach(product => {
    if (!product?.hasExpiration) return;

    const lots = computeLotBalances(movements, product.id)
      .filter(lot => lot.expirationDate);

    if (!lots.length) return;

    let productExpiringSoon = false;
    let productExpired = false;

    lots.forEach(lot => {
      const date = expirationToDate(lot.expirationDate);
      if (!date) return;

      const day = new Date(date);
      day.setHours(0, 0, 0, 0);

      if (day < now) {
        productExpired = true;
      } else if (day <= alertLimit) {
        productExpiringSoon = true;
      }
    });

    if (productExpired) expiredCount += 1;
    else if (productExpiringSoon) expiringSoonCount += 1;
  });

  return { expiringSoonCount, expiredCount };
}

export function buildBatchId() {
  return `lot_${Date.now()}`;
}

export async function refreshProductExpirationCache(productId, movements) {
  const nearest = getNearestExpiration(movements, productId);

  await updateDoc(doc(db, "products", productId), {
    expirationDate: nearest || null,
    updatedAt: serverTimestamp()
  });
}
