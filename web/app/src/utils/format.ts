export const formatDuration = (ms: number): string => {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}H ${m}M` : `${m}M`;
};
