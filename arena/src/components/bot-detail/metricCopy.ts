export const BOT_DETAIL_WINDOW_LABEL = '30D';

const WINDOW_SNAPSHOT_EXPLANATION = 'Calculated from the earliest renderable snapshot to the latest snapshot in the fetched 30-day metrics window.';

export const HEADER_RETURN_PERCENT_COPY = {
  label: `${BOT_DETAIL_WINDOW_LABEL} Return`,
  title: `${WINDOW_SNAPSHOT_EXPLANATION} This is not inception-to-date or all-time PnL.`,
};

export const PERFORMANCE_RETURN_WINDOW_COPY = {
  label: `${BOT_DETAIL_WINDOW_LABEL} Return $`,
  title: `${WINDOW_SNAPSHOT_EXPLANATION} This is a windowed dollar change, not an all-time return.`,
};

export const PERFORMANCE_RETURN_FALLBACK_COPY = {
  label: 'Net PnL $',
  title: 'Fallback from the backend metrics summary because 30-day history is unavailable. This value may not match the 30-day window semantics used elsewhere on this page.',
};

export const PERFORMANCE_SECTION_COPY = {
  title: `Performance (${BOT_DETAIL_WINDOW_LABEL})`,
  description: 'Returns use the earliest and latest renderable snapshots in the fetched 30-day metrics window.',
};
