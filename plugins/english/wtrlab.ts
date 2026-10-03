import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { gcm } from '@libs/aes';
import { storage } from '@libs/storage';

// wtr-lab moved the chapter text out of /api/reader/get (Oct 2026).
// New envelope: { success, chapter: { title, ... }, tasks: [], content_url }
// GET content_url -> { success, data: { ..., data: { body, glossary_data, model } } }
// Old inline shape:  { success, data: { data: { body, glossary_data, model } } }
type ChapterPayload = {
  body: string | string[];
  glossary_data?: { terms?: string[][] };
  title?: string;
  model?: string;
};

const GENRES = [
  'Action',
  'Adult',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Erciyuan',
  'Fan-Fiction',
  'Fantasy',
  'Game',
  'Gender-Bender',
  'Harem',
  'Historical',
  'Horror',
  'Josei',
  'Martial-Arts',
  'Mature',
  'Mecha',
  'Military',
  'Mystery',
  'Psychological',
  'Romance',
  'School-Life',
  'Sci-Fi',
  'Seinen',
  'Shoujo',
  'Shoujo-Ai',
  'Shounen',
  'Shounen-Ai',
  'Slice-Of-Life',
  'Smut',
  'Sports',
  'Supernatural',
  'Tragedy',
  'Urban-Life',
  'Wuxia',
  'Xianxia',
  'Xuanhuan',
  'Yaoi',
  'Yuri',
];

class WTRLAB implements Plugin.PluginBase {
  id = 'WTRLAB';
  name = 'WTR-LAB';
  site = 'https://wtr-lab.com/';
  version = '1.2.3';
  icon = 'src/en/wtrlab/icon.png';
  sourceLang = 'en/';

  baggage = '';
  trace = '';
  signInAttempted = false;

  pluginSettings: Plugin.PluginBase['pluginSettings'] = {
    signInUrl: {
      value: '',
      label:
        'Sign-in link — request "Continue with Email" on wtr-lab, then paste the full link from that email here (the plugin reads the token out of it and redeems it). Clear this field once AI chapters load; links are single-use and short-lived.',
      type: 'Text',
    },
    sessionCookie: {
      value: '',
      label:
        'Session cookie (fallback) — usually leave EMPTY. Android replaces this header with its own stored cookies whenever it has any, so the sign-in link above is the reliable route.',
      type: 'Text',
    },
    preferredMode: {
      value: 'ai',
      label: 'Preferred translation',
      type: 'Select',
      options: [
        { label: 'AI', value: 'ai' },
        { label: 'Web+', value: 'webplus' },
        { label: 'Web', value: 'web' },
        { label: 'Custom — set the id below', value: 'custom' },
      ],
    },
    customMode: {
      value: '',
      label:
        'Custom translation id — only used when "Custom" is selected above. This is the value wtr-lab sends as "translate" in its /api/reader/get request.',
      type: 'Text',
    },
    fallbackToWeb: {
      value: true,
      label: 'Fall back to Web when the preferred translation is unavailable',
      type: 'Switch',
    },
    showModeNotice: {
      value: true,
      label: 'Show which translation was used at the top of each chapter',
      type: 'Switch',
    },
  };

  filters = {
    search: {
      value: '',
      label: 'Search',
      type: FilterTypes.TextInput,
    },
    orderBy: {
      value: 'update',
      label: 'Order by',
      options: [
        { label: 'Update Date', value: 'update' },
        { label: 'Addition Date', value: 'date' },
        { label: 'Random', value: 'random' },
        { label: 'Weekly View', value: 'weekly_rank' },
        { label: 'Monthly View', value: 'monthly_rank' },
        { label: 'All-Time View', value: 'view' },
        { label: 'Name', value: 'name' },
        { label: 'Reader', value: 'reader' },
        { label: 'Chapter', value: 'chapter' },
        { label: 'Rating', value: 'rating' },
        { label: 'Review Count', value: 'total_rate' },
        { label: 'Vote Count', value: 'vote' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      value: 'desc',
      label: 'Order',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      value: 'all',
      label: 'Status',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
        { label: 'Hiatus', value: 'hiatus' },
        { label: 'Dropped', value: 'dropped' },
      ],
      type: FilterTypes.Picker,
    },
    release_status: {
      value: 'all',
      label: 'Release Status',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Released', value: 'released' },
        { label: 'On Voting', value: 'voting' },
      ],
      type: FilterTypes.Picker,
    },
    addition_age: {
      value: 'all',
      label: 'Addition Age',
      options: [
        { label: 'All', value: 'all' },
        { label: '< 2 Days', value: 'day' },
        { label: '< 1 Week', value: 'week' },
        { label: '< 1 Month', value: 'month' },
      ],
      type: FilterTypes.Picker,
    },
    min_chapters: {
      value: '',
      label: 'Minimum Chapters',
      type: FilterTypes.TextInput,
    },
    min_rating: {
      value: '',
      label: 'Minimum Rating (0.0-5.0)',
      type: FilterTypes.TextInput,
    },
    min_review_count: {
      value: '',
      label: 'Minimum Review Count',
      type: FilterTypes.TextInput,
    },
    genre_operator: {
      value: 'and',
      label: 'Genre (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Genres',
      type: FilterTypes.ExcludableCheckboxGroup,
      value: { include: [] as string[], exclude: [] as string[] },
      options: GENRES.map((label, i) => ({ label, value: String(i + 1) })),
    },
    folders: {
      value: '',
      label: 'Library Folders',
      options: [
        { label: 'No Filter', value: '' },
        { label: 'Reading', value: '1' },
        { label: 'Read Later', value: '2' },
        { label: 'Completed', value: '3' },
        { label: 'Trash', value: '5' },
      ],
      type: FilterTypes.Picker,
    },
    library_exclude: {
      value: '',
      label: 'Library Exclude',
      options: [
        { label: 'None', value: '' },
        { label: 'Exclude All', value: 'history' },
        { label: 'Exclude Trash', value: 'trash' },
        { label: 'Exclude Library & Trash', value: 'in_library' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;

  // ---------------------------------------------------------------- helpers

  get sessionCookie(): string {
    return (storage.get('sessionCookie') || '').trim();
  }

  get headers() {
    const h: Record<string, string> = {
      baggage: this.baggage,
      'sentry-trace': this.trace,
    };
    if (this.sessionCookie) h.Cookie = this.sessionCookie;
    return h;
  }

  get translationModes(): string[] {
    const preferred = (storage.get('preferredMode') || 'ai').trim();
    const custom = (storage.get('customMode') || '').trim();
    const fallback = storage.get('fallbackToWeb');
    const modes: string[] = [];
    if (preferred === 'custom') {
      if (custom) modes.push(custom);
    } else if (preferred) {
      modes.push(preferred);
    }
    if (fallback !== false && !modes.includes('web')) modes.push('web');
    if (modes.length === 0) modes.push('web');
    return modes;
  }

  /** True only for wtr-lab.com and its subdomains. */
  private isOwnHost(url: string): boolean {
    const m = url.match(/^https?:\/\/([^/:?#]+)/i);
    const host = m ? m[1].toLowerCase() : '';
    return host === 'wtr-lab.com' || host.endsWith('.wtr-lab.com');
  }

  private async ensureSignedIn(): Promise<string | null> {
    const raw = (storage.get('signInUrl') || '').trim();
    if (!raw || this.signInAttempted) return null;
    this.signInAttempted = true;

    if (
      /^[a-z]+:\/\//i.test(raw) &&
      !/^https:\/\/([a-z0-9-]+\.)*wtr-lab\.com\//i.test(raw)
    ) {
      return 'Sign-in link ignored — it is not an https wtr-lab.com address.';
    }

    let token = '';
    const m = raw.match(/[?&]token=([^&\s]+)/);
    if (m) token = decodeURIComponent(m[1]);
    else if (/^[A-Za-z0-9_.-]{16,}$/.test(raw)) token = raw;
    if (!token) {
      return 'Sign-in link ignored — no token found. Paste the whole link from the email (it contains "token=").';
    }

    const url = `${this.site}api/auth/magic-link/verify?token=${encodeURIComponent(
      token,
    )}&callbackURL=/`;
    try {
      const res = await fetchApi(url, {
        headers: {
          Accept: 'application/json,text/html,*/*',
          Referer: this.site,
        },
      });
      const endedAt = (res.url || '').replace(this.site, '/') || 'unknown';
      return `Sign-in: redeem token HTTP ${res.status}, ended at ${endedAt}`;
    } catch (e) {
      return `Sign-in failed: ${String(e)}`;
    }
  }

  private async checkSession(): Promise<string> {
    try {
      const cookie = this.sessionCookie;
      const res = await fetchApi(`${this.site}api/auth/get-session`, {
        headers: { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const user =
        json?.user ||
        json?.session?.user ||
        json?.data?.user ||
        json?.session?.session?.user;
      if (typeof user === 'string' && user) return `signed in (${user})`;
      if (user && typeof user === 'object') {
        const who = user.user_name || user.name || user.username || user.email || user.id || '';
        return who ? `signed in as ${who}` : 'signed in';
      }
      const snippet = text.slice(0, 60).replace(/<[^>]*>/g, ' ').trim() || 'empty response';
      return `NOT signed in (get-session HTTP ${res.status}: ${snippet})`;
    } catch (e) {
      return `session check failed: ${String(e)}`;
    }
  }

  private async fetchTokens(): Promise<void> {
    const html = await fetchApi(this.site + this.sourceLang).then(r => r.text());
    const $ = parseHTML(html);
    this.baggage = $('meta[name="baggage"]').attr('content') ?? '';
    this.trace = $('meta[name="sentry-trace"]').attr('content') ?? '';
  }

  // ---------------------------------------------------------------- browse

  async popularNovels(
    pageNo: number,
    { showLatestNovels, filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    if (showLatestNovels) {
      const res = await fetchApi(this.site + 'api/home/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: pageNo }),
      });
      const json: any = await res.json();
      return json.data.map((e: any) => ({
        name: e.serie.data.title || e.serie.slug || '',
        cover: e.serie.data.image,
        path: `${this.sourceLang}serie-${e.serie.raw_id}/${e.serie.slug || ''}`,
      }));
    }

    const p = new URLSearchParams();
    p.append('orderBy', filters.orderBy.value);
    p.append('order', filters.order.value);
    p.append('status', filters.status.value);
    p.append('release_status', filters.release_status.value);
    p.append('addition_age', filters.addition_age.value);
    p.append('page', pageNo.toString());
    if (filters.search.value) p.append('text', filters.search.value);

    const genres = filters.genres.value;
    if (genres?.include?.length) {
      p.append('gi', genres.include.join(','));
      p.append('gc', filters.genre_operator.value);
    }
    if (genres?.exclude?.length) p.append('ge', genres.exclude.join(','));
    if (filters.folders.value) p.append('folders', filters.folders.value);
    if (filters.library_exclude.value) p.append('le', filters.library_exclude.value);
    if (filters.min_chapters.value) p.append('count_value', filters.min_chapters.value);
    if (filters.min_rating.value) p.append('minr', filters.min_rating.value);
    if (filters.min_review_count.value) p.append('minrc', filters.min_review_count.value);

    // The finder is a Next.js page; its data route needs the current buildId.
    const html = await fetchApi(this.site + 'en/novel-finder').then(r => r.text());
    const nextData = parseHTML(html)('#__NEXT_DATA__').html();
    if (!nextData) throw new Error('Could not find __NEXT_DATA__ on novel finder page');
    const buildId = JSON.parse(nextData).buildId;

    const res = await fetchApi(
      `${this.site}_next/data/${buildId}/en/novel-finder.json?${p.toString()}`,
    );
    const json: any = await res.json();

    const seen = new Set<number>();
    return json.pageProps.series
      .filter((e: any) => {
        if (seen.has(e.raw_id)) return false;
        seen.add(e.raw_id);
        return true;
      })
      .map((e: any) => ({
        name: e.data.title,
        cover: e.data.image,
        path: `${this.sourceLang}serie-${e.raw_id}/${e.slug}`,
      }));
  }

  async searchNovels(searchTerm: string, pageNo: number): Promise<Plugin.NovelItem[]> {
    const filters = {
      ...this.filters,
      search: { ...this.filters.search, value: searchTerm },
    };
    return this.popularNovels(pageNo, { showLatestNovels: false, filters });
  }

  // ----------------------------------------------------------------- novel

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const html = await fetchApi(this.site + novelPath).then(r => r.text());
    const $ = parseHTML(html);

    const baggage = $('meta[name="baggage"]').attr('content');
    const trace = $('meta[name="sentry-trace"]').attr('content');
    if (baggage && trace) {
      this.baggage = baggage;
      this.trace = trace;
    } else if (!this.baggage || !this.trace) {
      await this.fetchTokens();
    }

    const nextRaw = $('#__NEXT_DATA__').html();
    let nextData: any = null;
    if (nextRaw) {
      try {
        nextData = JSON.parse(nextRaw);
      } catch (e) {
        console.error('Failed to parse __NEXT_DATA__:', e);
      }
    }
    const pageProps = nextData?.props?.pageProps;
    const serieData = pageProps?.serie?.serie_data;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1.text-uppercase').text(),
      summary: $('.lead').text().trim(),
    };

    let rawId: number | null = null;
    let slug: string | null = null;

    if (serieData) {
      novel.name = serieData.data?.title || '';
      novel.cover = serieData.data?.image || '';
      novel.summary = serieData.data?.description || '';
      novel.author = serieData.data?.author || '';
      rawId = serieData.raw_id || null;
      slug = serieData.slug || null;
      switch (serieData.status) {
        case 0:
          novel.status = 'Ongoing';
          break;
        case 1:
          novel.status = 'Completed';
          break;
        default:
          novel.status = 'Unknown';
      }
    }

    // HTML fallbacks for when __NEXT_DATA__ is missing fields
    if (!novel.name) {
      novel.name =
        $('h1.text-uppercase').text() ||
        $('h1.long-title').text() ||
        $('.title-wrap h1').text().trim();
    }
    if (!novel.cover) {
      novel.cover = $('.image-wrap img').attr('src') || $('.img-wrap > img').attr('src');
    }
    if (!novel.summary) {
      novel.summary =
        $('.description').text().trim() ||
        $('.desc-wrap .description').text().trim() ||
        $('.lead').text().trim();
    }

    // genres (ids -> names via the page's genre links) + tags
    const labels: string[] = [];
    try {
      const names = new Map<number, string>();
      $('a[href*="novel-list?genre="]').each((_, el) => {
        const m = ($(el).attr('href') || '').match(/genre=(\d+)/);
        const t = $(el).text().trim();
        if (m && t) names.set(parseInt(m[1], 10), t);
      });
      for (const id of serieData?.genres || []) {
        const n = names.get(id);
        if (n) labels.push(n.charAt(0).toUpperCase() + n.slice(1));
      }
      if (Array.isArray(pageProps?.tags)) {
        for (const tag of pageProps.tags) {
          const t = tag?.title && String(tag.title).trim();
          if (t) labels.push(t);
        }
      }
    } catch (e) {
      console.error('Failed to read genres/tags from __NEXT_DATA__:', e);
    }
    if (labels.length) {
      novel.genres = labels.filter((g, i) => labels.indexOf(g) === i).join(', ');
    }

    if (!novel.author) {
      novel.author =
        $('td:contains("Author")').next().text().replace(/[\t\n]/g, '').trim() ||
        $('td:contains("Author") + td').text().replace(/[\t\n]/g, '').trim();
    }

    const fromPath = novelPath.match(/(?:serie|novel)-?(\d+)\/([^/]+)/);
    if (fromPath) {
      rawId = parseInt(fromPath[1], 10);
      slug = fromPath[2];
    }

    novel.chapters = [];
    if (rawId && slug) {
      try {
        novel.chapters = await this.fetchAllChapters(rawId, slug);
      } catch (e) {
        console.error('Failed to fetch chapters via API:', e);
      }
    } else {
      console.warn('Could not extract rawId or slug from page', { rawId, slug });
    }
    return novel;
  }

  private async fetchAllChapters(
    rawId: number,
    slug: string,
  ): Promise<Plugin.ChapterItem[]> {
    const chapters: Plugin.ChapterItem[] = [];
    const size = 500;
    let start = 1;

    for (;;) {
      const end = start + size - 1;
      try {
        const res = await fetchApi(
          `${this.site}api/chapters/${rawId}?start=${start}&end=${end}`,
          { headers: this.headers },
        );
        const json: any = await res.json();
        const batch = json.chapters ?? json.data?.chapters ?? [];
        if (!Array.isArray(batch) || batch.length === 0) break;

        for (const c of batch) {
          chapters.push({
            name: c.title || c.name || `Chapter ${c.order}`,
            path: `${this.sourceLang}serie-${rawId}/${slug}/chapter-${c.order}`,
            releaseTime: c.updated_at?.substring(0, 10),
            chapterNumber: c.order,
          });
        }
        if (batch.length < size) break;
        start += size;
      } catch (e) {
        console.error(`Failed to fetch chapters ${start}-${end}:`, e);
        break;
      }
    }
    return chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));
  }

  // --------------------------------------------------------------- chapter

  private async decrypt(data: string, key: string): Promise<any> {
    try {
      let isArray = false;
      let payload = data;
      if (data.startsWith('arr:')) {
        isArray = true;
        payload = data.substring(4);
      } else if (data.startsWith('str:')) {
        payload = data.substring(4);
      }
      const parts = payload.split(':');
      if (parts.length !== 3) throw Error('Invalid encrypted data format');

      const [iv, tag, cipher] = parts.map(p =>
        Uint8Array.from(atob(p), c => c.charCodeAt(0)),
      );
      const combined = new Uint8Array(cipher.length + tag.length);
      combined.set(cipher);
      combined.set(tag, cipher.length);

      const keyBytes = new TextEncoder().encode(key.slice(0, 32));
      const plain = new TextDecoder().decode(gcm(keyBytes, iv).decrypt(combined));
      return isArray ? JSON.parse(plain) : plain;
    } catch (e) {
      console.error('Client-side decryption error:', e);
      return { error: `<p>Client-side decryption error:</p>${e}` };
    }
  }

  /** Finds the AES key in one of the page's JS bundles. */
  private async getKey($: ReturnType<typeof parseHTML>): Promise<string> {
    const marker = 'TextEncoder().encode("';
    const srcs: string[] = [];
    $('head')
      .find('script')
      .toArray()
      .forEach(s => {
        const src = $(s).attr('src');
        if (src && !srcs.includes(src)) srcs.push(src);
      });

    for (const src of srcs) {
      const code = await fetchApi(`${this.site}${src}`)
