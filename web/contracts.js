/**
 * @typedef {{url: string, srcset?: string}} Thumbnail
 * @typedef {{language: string, label: string, url: string}} SubtitleTrack
 * @typedef {{name: string, contentType: string, width: number, height: number,
 *   framerate: number, bitrate: number}} Encoding
 * @typedef {{id: string, sourceRef: string, filename: string, title: string,
 *   durationSeconds: number, sizeBytes: number, resolution: string,
 *   quality: string, codec: string, encoding: Encoding|null,
 *   thumbnail: Thumbnail,
 *   seekPreviewUrl: string,
 *   subtitleTracks: SubtitleTrack[],
 *   audioTrackCount: number}} MediaPart
 * @typedef {{index: number, language: string, title: string, codec: string,
 *   default: boolean, playable: boolean}} AudioTrack
 * @typedef {{track: string, artist: string, album: string, trackNumber: number,
 *   year: number}} MusicTrack
 * @typedef {{id: string, title: string, favourite: boolean, parts: MediaPart[],
 *   audioOnly: boolean, music: MusicTrack|null,
 *   facets: {people: object[], owner: object|null, collections: object[],
 *   ordinal: string|null}, archive: {webpageUrl: string, downloaded: boolean,
 *   extractor: string, description: string, uploadedAt: number,
 *   viewCount: number, likeCount: number, refreshedAt: number, fps: number, container: string,
 *   audioCodec: string, subtitleLanguages: string[],
 *   chapters: {startSeconds: number, endSeconds: number, title: string}[],
 *   heatmap: {startSeconds: number, endSeconds: number, value: number}[],
 *   detailsUrl: string, detailsLoaded?: boolean,
 *   commentsUrl: string, commentCount: number, chatHeld: boolean,
 *   chatUrl: string, chatOffered: boolean,
 *   playlists: Array<object>,
 *   playlist: {id: string, title: string, index: number, count: number,
 *   url: string, uploader: string, uploads: boolean}|null}}} MediaItem
 * @typedef {{url: string, type?: string, seekPreviewUrl?: string,
 *   subtitleTracks?: SubtitleTrack[]}} MediaSource
 */

/**
 * One comment under a video, replies nested one level as YouTube shows them.
 * @typedef {{id: string, author: string, avatarUrl: string, text: string,
 *   likes: number, postedAt: number, edited: boolean, pinned: boolean,
 *   hearted: boolean, byUploader: boolean, replies: Comment[]}} Comment
 */

export {};
