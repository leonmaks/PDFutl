export const pdfTimelineSource = 'pdfutl.savedCopies';

export function formatPdfTimelineDate(timestamp: number): string {
  const date = new Date(timestamp);
  const twoDigits = (value: number) => String(value).padStart(2, '0');
  const day = [date.getFullYear() % 100, date.getMonth() + 1, date.getDate()].map(twoDigits).join('.');
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(':');
  return day + ' ' + time;
}
