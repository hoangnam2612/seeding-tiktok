import { TikTokAccount } from '../nest/accounts/account.interface';

export type Command = 'video' | 'live' | 'profile' | 'upload' | 'login' | 'outlook';
export interface BrowserSettings {
  columns: number; rows: number; scaleFactor: number; livePageZoom: number; maxThreads: number;
  autoArrangeGrid: boolean; disableImages: boolean; disableAudio: boolean; windowWidth: number; windowHeight: number;
}
export const browserDefaults: BrowserSettings = { columns: 4, rows: 2, scaleFactor: .65, livePageZoom: .8, maxThreads: 4, autoArrangeGrid: true, disableImages: false, disableAudio: true, windowWidth: 0, windowHeight: 0 };
export interface VideoConfig { videoUrls: string[]; minViewSeconds: number; maxViewSeconds: number; isLike: boolean; isComment: boolean; comments: string[]; isFollow: boolean; isFavorite: boolean; minDelaySeconds: number; maxDelaySeconds: number }
export interface LiveConfig { liveUrls: string[]; minWatchMinutes: number; maxWatchMinutes: number; isSendHearts: boolean; heartClicksPerRound: number; isCommentLive: boolean; liveComments: string[]; commentIntervalSeconds: number; isFollowHost: boolean }
export interface ProfileConfig { isChangeAvatar: boolean; avatarFolder: string; avatarFiles: string[]; isChangeName: boolean; names: string[]; isChangeUsername: boolean; usernames: string[]; appendRandomNumber: boolean; minRandomNumber: number; maxRandomNumber: number; isChangeBio: boolean; bios: string[]; minDelaySeconds: number; maxDelaySeconds: number; avoidDuplicateContent: boolean }
export interface Product { id: string; displayName: string }
export interface UploadItem { path: string; title: string; description: string; size: string; product?: Product }
export interface UploadConfig { videos: UploadItem[]; attachProducts: boolean; products: Product[]; captions: string[]; hashtags: string[]; tags: string[]; useVideoDescription: boolean; setPublicVisibility: boolean; maxTags: number; uploadTimeoutSeconds: number; postWaitSeconds: number }
export type Config = VideoConfig | LiveConfig | ProfileConfig | UploadConfig | Record<string, never>;
export interface WorkflowEvent { type: 'progress' | 'item' | 'device-code'; accountId: string; message?: string; success?: boolean; file?: string; url?: string; code?: string }
export interface Hooks { emit: (event: WorkflowEvent) => void; update: (id: string, update: Partial<TikTokAccount>) => void }
export const defaults = {
  video: { videoUrls: [], minViewSeconds: 5, maxViewSeconds: 15, isLike: true, isComment: true, comments: [], isFollow: false, isFavorite: false, minDelaySeconds: 3, maxDelaySeconds: 6 } as VideoConfig,
  live: { liveUrls: [], minWatchMinutes: 1, maxWatchMinutes: 3, isSendHearts: true, heartClicksPerRound: 15, isCommentLive: true, liveComments: [], commentIntervalSeconds: 15, isFollowHost: false } as LiveConfig,
  profile: { isChangeAvatar: false, avatarFolder: '', avatarFiles: [], isChangeName: false, names: [], isChangeUsername: false, usernames: [], appendRandomNumber: true, minRandomNumber: 1000, maxRandomNumber: 9999, isChangeBio: false, bios: [], minDelaySeconds: 2, maxDelaySeconds: 5, avoidDuplicateContent: false } as ProfileConfig,
  upload: { videos: [], attachProducts: false, products: [], captions: [], hashtags: [], tags: [], useVideoDescription: true, setPublicVisibility: true, maxTags: 3, uploadTimeoutSeconds: 180, postWaitSeconds: 30 } as UploadConfig,
};
