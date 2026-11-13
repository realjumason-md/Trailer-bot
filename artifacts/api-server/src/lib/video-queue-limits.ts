export const MAX_WAITING_COMPRESSIONS = 10;
export const MAX_OUTSTANDING_VIDEOS = MAX_WAITING_COMPRESSIONS + 1;

export function canAcceptVideo(outstandingVideoCount: number): boolean {
  return outstandingVideoCount < MAX_OUTSTANDING_VIDEOS;
}
