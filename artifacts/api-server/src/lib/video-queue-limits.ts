export const MAX_OUTSTANDING_VIDEOS = 6;
export const MAX_WAITING_COMPRESSIONS = MAX_OUTSTANDING_VIDEOS - 1;

export function canAcceptVideo(outstandingVideoCount: number): boolean {
  return outstandingVideoCount < MAX_OUTSTANDING_VIDEOS;
}
