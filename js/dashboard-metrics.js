export function dashboardLeadTotal(funnel = {}) {
  const total = Number(funnel?.total);
  if (Number.isSafeInteger(total) && total >= 0) return total;
  return Object.entries(funnel || {}).reduce((sum, [key, value]) => {
    if (key === 'total') return sum;
    const count = Number(value);
    return sum + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}
