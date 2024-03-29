import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus
} from '@discordjs/voice';
import got from 'got';
import play from 'play-dl';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  InteractionCollector,
  Message,
  MessageCreateOptions,
  TextChannel,
  VoiceChannel
} from 'discord.js';
import { shuffle } from '@in5net/limitless';
import type { AudioResource } from '@discordjs/voice';

import Queue, { secondsToTime } from './queue.js';
import { getLyrics } from '$services/genius.js';
import {
  SoundCloudMedia,
  SpotifyMedia,
  URLMedia,
  YouTubeMedia
} from './media.js';
import * as playlist from './playlist.js';
import { addOwnerUsername, color } from '$services/config.js';
import bot from '../bot.js';
import type { MediaType } from './media.js';

const YOUTUBE_CHANNEL_REGEX =
  /https?:\/\/(?:www\.)?youtube\.com\/(channel|c)\/([a-zA-Z0-9_-]+)/;
const URL_REGEX =
  /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)?/i;

export default class Player {
  private player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  })
    .on(AudioPlayerStatus.Idle, async () => {
      if (this.soundboardCollector) return;

      try {
        if (this.queue.size) {
          await this.joinVoice();
          await this.play();
        } else await this.stop();
      } catch (error) {
        console.error('⚠️ Player error:', error);
        await this.send('⚠️ Error');
        await this.next();
      }
    })
    .on('error', async error => {
      console.error('⚠️ Player error:', error);
      try {
        await this.send('⚠️ Error');
        await this.next();
      } catch (error) {
        console.error('⚠️ Error:', error);
      }
    });

  private channel?: TextChannel;
  private voiceChannel?: VoiceChannel;
  private connection?: VoiceConnection;
  private message?: Message;

  private soundboardCollector?: InteractionCollector<ButtonInteraction>;
  private playlistGetCollector?: InteractionCollector<ButtonInteraction>;

  readonly queue = new Queue();
  private timestamp = 0;

  constructor(private onStop: () => void) {}

  async send(message: string | MessageCreateOptions): Promise<void> {
    await this.message?.delete().catch(() => {});
    this.message = await this.channel?.send(message);
  }

  setChannels(message: Message): void {
    const { channel, member } = message;
    if (channel.type === ChannelType.GuildText) this.channel = channel;
    const voiceChannel = member?.voice.channel;
    if (voiceChannel?.type === ChannelType.GuildVoice)
      this.voiceChannel = voiceChannel;
  }

  async getMedias(message: Message, query?: string): Promise<MediaType[]> {
    const { player, queue } = this;
    const { author, member, attachments } = message;
    const requester = {
      uid: author.id,
      name: member?.nickname || author.username
    };

    const urlMediasCache = new Map<string, URLMedia>();
    for (const { url } of attachments.values()) {
      let media = urlMediasCache.get(url);
      if (!media) {
        media = await URLMedia.fromURL(url, requester);
        urlMediasCache.set(url, media);
      }
      queue.enqueue(media);
      media.log();
      if (player.state.status === AudioPlayerStatus.Playing)
        await this.send(`⏏️ Added ${media.title} to queue`);
    }

    const queries: string[] = [];
    if (query) {
      const words = query.split(' ').filter(Boolean);
      let text = '';
      for (const word of words) {
        const isUrl = URL_REGEX.test(word);
        if (isUrl) {
          if (text.trim()) {
            queries.push(text.trim());
            text = '';
          }
          queries.push(word);
        } else text += `${word} `;
      }
      if (text) {
        queries.push(...text.trim().split('\n'));
        text = '';
      }
    }
    console.log('Queries:', queries);

    const medias: MediaType[] = [];
    const mediasCache = new Map<string, MediaType[]>();
    if (play.is_expired()) await play.refreshToken();
    for (const query of queries) {
      const mds = mediasCache.get(query);
      if (mds) {
        medias.push(...mds);
        continue;
      }
      if (play.yt_validate(query) === 'playlist') {
        const id = play.extractID(query);
        try {
          const videos = await YouTubeMedia.fromPlaylistId(id, requester);
          medias.push(...videos);
          mediasCache.set(query, videos);
        } catch (error) {
          await this.send('🚫 Invalid YouTube playlist url');
        }
      } else if (play.yt_validate(query) === 'video') {
        try {
          const media = await YouTubeMedia.fromURL(query, requester);
          medias.push(media);
          mediasCache.set(query, [media]);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid YouTube video url');
        }
      } else if (YOUTUBE_CHANNEL_REGEX.test(query)) {
        try {
          const id = YOUTUBE_CHANNEL_REGEX.exec(query)?.[2] || '';
          const videos = await YouTubeMedia.fromChannelId(id, requester);
          medias.push(...videos);
          mediasCache.set(query, videos);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid YouTube channel url');
        }
      } else if (play.sp_validate(query) === 'track') {
        try {
          const media = await SpotifyMedia.fromURL(query, requester);
          medias.push(media);
          mediasCache.set(query, [media]);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid Spotify song url');
        }
      } else if (
        ['album', 'playlist'].includes(play.sp_validate(query) as string)
      ) {
        try {
          const songs = await SpotifyMedia.fromListURL(query, requester);
          medias.push(...songs);
          mediasCache.set(query, songs);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid Spotify album/playlist url');
        }
      } else if ((await play.so_validate(query)) === 'track') {
        try {
          const media = await SoundCloudMedia.fromURL(query, requester);
          medias.push(media);
          mediasCache.set(query, [media]);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid SoundCloud song url');
        }
      } else if ((await play.so_validate(query)) === 'playlist') {
        try {
          const medias = await SoundCloudMedia.fromListURL(query, requester);
          medias.push(...medias);
          mediasCache.set(query, medias);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid SoundCloud playlist url');
        }
      } else if (URL_REGEX.test(query)) {
        try {
          const media = await URLMedia.fromURL(query, requester);
          medias.push(media);
          mediasCache.set(query, [media]);
        } catch (error) {
          console.error(error);
          await this.send('🚫 Invalid song url');
        }
      } else {
        try {
          const media = await YouTubeMedia.fromSearch(query, requester);
          medias.push(media);
          mediasCache.set(query, [media]);
        } catch (error) {
          console.error(error);
          this.send('🚫 Invalid YouTube query');
        }
      }
    }
    medias.forEach(media => media.log());
    return medias;
  }

  async add(message: Message, query?: string, shuffle = false): Promise<void> {
    this.setChannels(message);

    const { queue, channel } = this;

    const medias = await this.getMedias(message, query);
    queue.enqueue(...medias);
    if (shuffle) queue.shuffle();

    if (medias.length)
      await channel?.send(
        `⏏️ Added${shuffle ? ' & shuffled' : ''} ${medias
          .map(media => media.title)
          .slice(0, 10)
          .join(', ')}${medias.length > 10 ? ', ...' : ''} to queue`
      );

    return this.play();
  }

  async playnow(message: Message, query?: string): Promise<void> {
    this.setChannels(message);

    const { queue, channel } = this;

    const medias = await this.getMedias(message, query);
    queue.enqueueNow(...medias);

    if (medias.length)
      await channel?.send(
        `⏏️ Added ${medias
          .map(media => media.title)
          .slice(0, 10)
          .join(', ')}${
          medias.length > 10 ? ', ...' : ''
        } to the front of the queue`
      );

    return this.play(true);
  }

  async next(): Promise<void> {
    await this.play(true);
    await this.channel?.send('⏩ Next');
  }

  async seek(message: Message, seconds: number) {
    const {
      player,
      queue: { current }
    } = this;
    if (!current) return message.channel.send('No song is playing');
    if (!(current instanceof YouTubeMedia))
      return message.channel.send(
        'This command is only available for YouTube songs'
      );

    if (play.is_expired()) await play.refreshToken();

    const stream = await play.stream(current.url, {
      seek: seconds
    });
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });
    return player.play(resource);
  }

  async pause(): Promise<void> {
    const { player, channel } = this;
    const paused = player.state.status === AudioPlayerStatus.Paused;
    if (paused) await player.unpause();
    else await player.pause(true);
    await channel?.send(paused ? '⏯️ Resumed' : '⏸️ Paused');
  }

  toggleLoop(): Promise<void> {
    this.queue.toggleLoop();
    return this.send(`🔁 Loop ${this.queue.loop ? 'enabled' : 'disabled'}`);
  }

  shuffle(): Promise<void> {
    this.queue.shuffle();
    return this.send('🔀 Shuffled queue');
  }

  async move(from: number, to: number): Promise<void> {
    this.queue.move(from, to);
    return this.send(`➡️ Moved #${from + 2} to #${to + 2}`);
  }

  async remove(...indices: number[]): Promise<void> {
    const { queue } = this;
    const { length } = queue;
    indices.forEach(i => queue.remove(i));
    return this.send(
      `✂️ Removed ${indices.join(', ')}, total of ${
        length - queue.length
      } songs`
    );
  }

  async stop(): Promise<void> {
    const { player, connection, queue, onStop } = this;
    if (
      connection &&
      connection.state.status !== VoiceConnectionStatus.Destroyed
    )
      connection.destroy();
    player.stop();
    queue.clear();
    queue.loop = false;
    this.soundboardCollector?.stop();
    this.channel =
      this.voiceChannel =
      this.connection =
      this.soundboardCollector =
        undefined;
    bot.client.user?.setActivity();
    this.queue.changeEmitter.removeAllListeners();
    onStop();
  }

  async soundboard(message: Message): Promise<void> {
    const soundsPath = join(__dirname, '../../sounds');
    const fileNames = await readdir(soundsPath);
    const soundNames = fileNames.map(fileName => fileName.replace('.ogg', ''));
    const shuffledNames = shuffle(soundNames).slice(0, 4 * 5);

    const buttons = shuffledNames.map(soundName =>
      new ButtonBuilder()
        .setCustomId(soundName)
        .setLabel(soundName)
        .setStyle(ButtonStyle.Primary)
    );
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    const columns = 4;
    for (let i = 0; i < buttons.length; i += columns) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.slice(i, i + columns)
      );
      rows.push(row);
    }

    this.setChannels(message);
    await this.send({ content: '🎵 Soundboard', components: rows });
    console.log(`🎵 Soundboard created`);
    this.soundboardCollector?.stop();
    this.soundboardCollector = this.message
      ?.createMessageComponentCollector({ componentType: ComponentType.Button })
      .on('collect', async i => {
        if (i.customId === 'stop') {
          this.soundboardCollector?.stop();
          this.soundboardCollector = undefined;
          return;
        }
        this.joinVoice();

        const soundName = i.customId;
        console.log('Sound:', soundName);
        const soundPath = join(soundsPath, `${soundName}.ogg`);
        const resource = createAudioResource(soundPath, {
          inputType: StreamType.OggOpus
        });
        this.player.play(resource);

        try {
          await i?.update({});
        } catch (error) {
          console.error('Interaction error:', error);
        }
      });
  }

  private joinVoice() {
    const { player, voiceChannel, connection } = this;
    if (!voiceChannel) return;

    console.log(`From: voice connection ${connection?.state.status || 'gone'}`);

    switch (connection?.state.status) {
      case VoiceConnectionStatus.Ready:
      case VoiceConnectionStatus.Signalling:
      case VoiceConnectionStatus.Connecting:
        break;
      default:
        connection?.destroy();
        this.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator
        });
        this.connection
          .on(VoiceConnectionStatus.Disconnected, () => this.joinVoice())
          .subscribe(player);
    }

    console.log(
      `To: voice connection ${this.connection?.state.status || 'gone'}`
    );
  }

  private async play(skip = false): Promise<void> {
    const { player, queue } = this;

    if (this.soundboardCollector) {
      this.soundboardCollector.stop();
      this.soundboardCollector = undefined;
    }

    this.joinVoice();

    if (player.state.status === AudioPlayerStatus.Playing && !skip) return;

    const media = queue.next();
    if (!media) {
      await this.send('📭 Queue is empty');
      return this.stop();
    }

    const { title } = media;
    let resource: AudioResource;
    if (media instanceof YouTubeMedia || media instanceof SpotifyMedia) {
      if (play.is_expired()) await play.refreshToken();
    }
    if (media instanceof YouTubeMedia || media instanceof SoundCloudMedia) {
      const { url } = media;
      const stream = await play.stream(url, {
        seek: media instanceof YouTubeMedia ? media.time : undefined
      });
      resource = createAudioResource(stream.stream, { inputType: stream.type });
      console.log(`▶️ Playing ${url}`);
    } else if (media instanceof SpotifyMedia) {
      const stream = await play.stream(media.youtubeURL);
      resource = createAudioResource(stream.stream, { inputType: stream.type });
      console.log(`▶️ Playing ${media.url}`);
    } else if (media instanceof URLMedia) {
      const steam = await got.stream(media.url);
      resource = createAudioResource(steam);
      console.log(`▶️ Playing ${media.url}`);
    } else {
      resource = createAudioResource(media.path);
      console.log(`▶️ Playing ${media.path}`);
    }

    player.play(resource);
    this.timestamp = 0;

    player.once(AudioPlayerStatus.Playing, () => {
      this.timestamp = this.connection?.receiver.connectionData.timestamp || 0;
    });
    bot.client.user?.setActivity(title);

    try {
      const embed = media.getEmbed().setTitle(`▶️ Playing: ${title}`);
      addOwnerUsername(embed);
      return await this.send({
        embeds: [embed]
      });
    } catch (error) {
      console.error('Error creating embed:', error);
    }
  }

  async queueEmbed(message: Message): Promise<void> {
    this.setChannels(message);
    const { channel, connection, queue, timestamp } = this;
    if (channel)
      await queue.embed(
        channel,
        (connection?.receiver.connectionData.timestamp || 0) - timestamp
      );
  }

  songQueueEmbed(n: number) {
    return this.queue.songEmbed(n - 1);
  }

  async lyrics(message: Message, query?: string): Promise<void> {
    this.setChannels(message);
    const lyrics = await this.getLyrics(query);
    if (lyrics.length <= 2000) return this.send(lyrics);
    return this.send({
      files: [
        new AttachmentBuilder(Buffer.from(lyrics), { name: 'lyrics.txt' })
      ]
    });
  }

  private getLyrics(query?: string) {
    if (query) return getLyrics(query);
    const { current } = this.queue;
    if (current) {
      const { title } = current;
      if (current instanceof SpotifyMedia)
        return getLyrics(`${title} ${current.artist.name}`);
      return Promise.resolve(getLyrics(title));
    }
    return Promise.resolve('No song playing');
  }

  async playlistGet(
    { author, member, channel }: Message,
    name: string
  ): Promise<void> {
    const medias = await playlist
      .get(
        {
          uid: author.id,
          name: member?.nickname || author.username
        },
        name
      )
      .catch(() => []);
    const { length } = medias;

    const embed = new EmbedBuilder()
      .setTitle('Tracks')
      .setColor(color)
      .setAuthor({
        name: author.username,
        iconURL: author.avatarURL() || undefined
      });
    const backButton = new ButtonBuilder()
      .setCustomId('back')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Primary);
    const nextButton = new ButtonBuilder()
      .setCustomId('next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      backButton,
      nextButton
    );

    let page = 0;
    const pageSize = 5;

    const generateEmbed = () => {
      embed.setFields();
      backButton.setDisabled(!page);
      nextButton.setDisabled(page * pageSize + pageSize >= length);
      embed.setFooter({
        text: `Page ${page + 1}/${Math.ceil(
          length / pageSize
        )}, total: ${length}`
      });
      addOwnerUsername(embed);

      for (let i = page * pageSize; i < (page + 1) * pageSize; i++) {
        const media = medias[i];
        if (!media) break;
        const { title, duration } = media;
        embed.addFields({
          name: `${i + 1}. ${title}`,
          value: `${secondsToTime(duration)}`
        });
      }
    };
    generateEmbed();

    const message = await channel.send({ embeds: [embed], components: [row] });
    this.playlistGetCollector?.stop();
    this.playlistGetCollector = message
      .createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60_000
      })
      .on('collect', async i => {
        const { customId } = i;
        if (customId === 'back') page--;
        else if (customId === 'next') page++;
        generateEmbed();
        await message.edit({ embeds: [embed], components: [row] });
        await i.update({ files: [] });
      });
  }

  async playlistList({ author, channel }: Message): Promise<void> {
    const playlists = await playlist.list(author.id);
    const desc = playlists.join('\n');
    const embed = new EmbedBuilder()
      .setTitle('Playlists')
      .setColor(color)
      .setAuthor({
        name: author.username,
        iconURL: author.avatarURL() || undefined
      })
      .setDescription(desc.length > 1000 ? `${desc.slice(0, 1000)}...` : desc);
    addOwnerUsername(embed);
    await channel.send({ embeds: [embed] });
  }

  async playlistSave(
    message: Message,
    name: string,
    query?: string
  ): Promise<void> {
    const { author, channel } = message;
    const medias = query
      ? await this.getMedias(message, query)
      : this.queue.getMedias();
    await playlist.save(author.id, name, medias);
    await channel.send(`Saved playlist ${name}`);
  }

  async playlistAdd(
    message: Message,
    name: string,
    query?: string
  ): Promise<void> {
    const { author, channel } = message;
    const medias = query
      ? await this.getMedias(message, query)
      : this.queue.getMedias();
    await playlist.add(author.id, name, medias);
    await channel.send(`Added to playlist ${name}`);
  }

  async playlistLoad(message: Message, names: string[]): Promise<void> {
    this.setChannels(message);
    const { author, member } = message;
    const allMedias: MediaType[] = [];
    const cache = new Map<string, MediaType[]>();
    for (const name of names) {
      let medias = cache.get(name);
      if (!medias) {
        medias = await playlist
          .get(
            {
              uid: author.id,
              name: member?.nickname || author.username
            },
            name
          )
          .catch(() => []);
      }
      allMedias.push(...medias);
    }
    this.queue.enqueue(...allMedias);
    await message.channel.send(`Loaded ${allMedias.length} songs`);
    await this.play();
  }

  async playlistLoads(message: Message, names: string[]): Promise<void> {
    this.setChannels(message);
    const { author, member } = message;
    const allMedias: MediaType[] = [];
    const cache = new Map<string, MediaType[]>();
    for (const name of names) {
      let medias = cache.get(name);
      if (!medias) {
        medias = await playlist.get(
          {
            uid: author.id,
            name: member?.nickname || author.username
          },
          name
        );
      }
      allMedias.push(...medias);
    }
    this.queue.enqueue(...shuffle(allMedias));
    await message.channel.send(`Loaded ${allMedias.length} songs`);
    await this.play();
  }

  async playlistRemove(
    { author, channel }: Message,
    name: string,
    n?: number
  ): Promise<void> {
    await playlist.remove(author.id, name, n);
    await channel.send(
      n === undefined
        ? `Removed playlist ${name}`
        : `Removed #${n} from playlist ${name}`
    );
  }
}
