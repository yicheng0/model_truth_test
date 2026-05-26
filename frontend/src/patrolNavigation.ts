import type { ChannelAlert } from './types';
import { alertResultId } from './scheduledAlertLog';

function cleanValue(value?: string | null) {
  const text = value?.trim();
  return text || '';
}

export function buildPatrolRunDetailLink(alert: Pick<ChannelAlert, 'run_id' | 'report_id' | 'evidence_summary'>) {
  const resultId = cleanValue(alertResultId(alert as ChannelAlert));
  const params = new URLSearchParams();
  params.set('focus', 'patrol');
  params.set('reportId', alert.report_id);
  if (resultId) {
    params.set('resultId', resultId);
  } else {
    params.set('section', 'signature');
  }
  return `/runs/${alert.run_id}?${params.toString()}`;
}
