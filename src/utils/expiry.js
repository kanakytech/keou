const EXPIRY_DAYS = 14;

/** Calculate expiry info for a KIE.AI generation */
export function getExpiryInfo(createdAt) {
  const created = new Date(createdAt);
  const expiresAt = new Date(created.getTime() + EXPIRY_DAYS * 86400000);
  const now = new Date();
  const daysLeft = Math.ceil((expiresAt - now) / 86400000);

  return {
    expiresAt: expiresAt.toISOString(),
    daysLeft: Math.max(0, daysLeft),
    isExpired: daysLeft <= 0,
    urgency: daysLeft <= 0 ? 'expired' : daysLeft <= 3 ? 'critical' : daysLeft <= 7 ? 'warning' : 'ok',
  };
}

/** Add expiry info to an array of generation items — skip if persisted to R2 */
export function addExpiryInfo(items) {
  return items.map(item => ({
    ...item,
    expiry: item.r2_key ? null : getExpiryInfo(item.created_at),
  }));
}
