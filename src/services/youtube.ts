import { youtube } from '@googleapis/youtube';

const api = youtube({
  version: 'v3',
  auth: process.env.GOOGLE_APIS_KEY
});

export async function search(query: string): Promise<Video> {
  const searchRes = await api.search.list({
    q: query,
    type: ['video'],
    part: ['id', 'snippet'],
    maxResults: 1
  });
  const searchItem = searchRes.data.items?.[0];
  const id = searchItem?.id?.videoId || '';
  const video = await getDetails(id);
  return video;
}

export interface Video {
  id: string;
  title: string;
  description?: string;
  thumbnail?: string;
  duration: number;
  channel?: Channel;
}
export async function getDetails(id: string): Promise<Video> {
  const videoRes = await api.videos.list({
    id: [id],
    part: ['snippet', 'contentDetails'],
    maxResults: 1
  });
  const videoItem = videoRes.data.items?.[0];
  const title = videoItem?.snippet?.title || '';
  const description = videoItem?.snippet?.description || undefined;
  const thumbnail = videoItem?.snippet?.thumbnails?.default?.url || undefined;
  const duration = videoItem?.contentDetails?.duration || '';
  console.log('YouTube duration str:', duration);

  const channelId = videoItem?.snippet?.channelId;
  const channel = channelId ? await getChannel(channelId) : undefined;

  return {
    id,
    title,
    description,
    thumbnail,
    duration: durationStr2Sec(duration),
    channel
  };
}

function durationStr2Sec(duration: string) {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/) || [];

  const parts = match.slice(1).map(str => str.replace(/\D/, ''));

  const hours = parseInt(parts[0] || '') || 0;
  const minutes = parseInt(parts[1] || '') || 0;
  const seconds = parseInt(parts[2] || '') || 0;

  return hours * 3600 + minutes * 60 + seconds;
}

export async function getPlaylist(id: string): Promise<Video[]> {
  const videos: Video[] = [];
  let nextPageToken: string | null | undefined;
  do {
    const playlistRes = await api.playlistItems.list({
      playlistId: id,
      part: ['snippet', 'contentDetails'],
      maxResults: 50,
      pageToken: nextPageToken || undefined
    });
    const pageVideos = await Promise.all(
      playlistRes.data.items?.map(async item => ({
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        thumbnail: item.snippet?.thumbnails?.default?.url || '',
        duration:
          parseInt(item.contentDetails?.endAt || '0') -
          parseInt(item.contentDetails?.startAt || '0'),
        channel: await getChannel(item.snippet?.videoOwnerChannelId || ''),
        id: item.contentDetails?.videoId || ''
      })) || []
    );
    videos.push(...pageVideos);
    console.log(playlistRes.data.items?.[0]?.contentDetails);
    ({ nextPageToken } = playlistRes.data);
  } while (nextPageToken);
  return videos;
}

export interface Channel {
  title: string;
  thumbnail: string;
  id: string;
}
export async function getChannel(id: string): Promise<Channel> {
  const channelRes = await api.channels.list({
    id: [id],
    part: ['snippet']
  });
  const channelItem = channelRes.data.items?.[0];
  const title = channelItem?.snippet?.title || '';
  const thumbnail = channelItem?.snippet?.thumbnails?.default?.url || '';
  return {
    title,
    thumbnail,
    id
  };
}

export async function getChannelVideos(id: string): Promise<Video[]> {
  const channel = await getChannel(id);

  const videos: Video[] = [];
  let nextPageToken: string | null | undefined;
  do {
    const playlistRes = await api.search.list({
      channelId: id,
      part: ['snippet'],
      order: 'date',
      maxResults: 50,
      pageToken: nextPageToken || undefined
    });
    const pageVideos = await Promise.all(
      playlistRes.data.items?.map(async item => ({
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        thumbnail: item.snippet?.thumbnails?.default?.url || '',
        duration: NaN,
        channel,
        id: item.id?.videoId || ''
      })) || []
    );
    videos.push(...pageVideos);
    ({ nextPageToken } = playlistRes.data);
  } while (nextPageToken && videos.length < 100);
  return videos;
}
