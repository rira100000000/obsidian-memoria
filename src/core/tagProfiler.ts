// src/core/tagProfiler.ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { StorageAdapter } from './interfaces/storageAdapter';
import { LLMAdapter } from './interfaces/llmAdapter';
import { NotificationAdapter } from './interfaces/notificationAdapter';
import { GeminiPluginSettings, DEFAULT_SETTINGS } from '../settings';
import { GeminiLLMAdapter } from '../adapters/geminiLLMAdapter';
import {
  TagScores,
  TagProfilingNoteFrontmatter,
  ParsedLlmTpnData,
  SummaryNoteFrontmatter
} from './types';

const TAG_PROFILING_NOTE_DIR = 'TagProfilingNote';
const TAG_SCORES_FILE = 'tag_scores.json';

function formatNow(format: 'date-hm' | 'date-slash'): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const Y = now.getFullYear();
  const M = pad(now.getMonth() + 1);
  const D = pad(now.getDate());
  const h = pad(now.getHours());
  const m = pad(now.getMinutes());
  if (format === 'date-hm') return `${Y}-${M}-${D} ${h}:${m}`;
  return `${Y}/${M}/${D}`;
}

function formatDateSlash(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function parseDateTimeStr(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  return isNaN(date.getTime()) ? null : date;
}

export class TagProfiler {
  private storage: StorageAdapter;
  private llm: LLMAdapter;
  private settings: GeminiPluginSettings;
  private notify: NotificationAdapter;

  constructor(storage: StorageAdapter, llm: LLMAdapter, settings: GeminiPluginSettings, notify: NotificationAdapter) {
    this.storage = storage;
    this.llm = llm;
    this.settings = settings;
    this.notify = notify;
  }

  public onSettingsChanged(settings: GeminiPluginSettings) {
    this.settings = settings;
    console.log('[TagProfiler] Settings changed.');
  }

  /**
   * SummaryNoteファイルを処理してタグプロファイルを更新する。
   * @param summaryNotePath SummaryNoteのファイルパス
   */
  public async processSummaryNote(summaryNotePath: string): Promise<void> {
    if (!this.llm.isAvailable()) {
      this.notify.error("タグプロファイリング: LLMが初期化されていません。設定を確認してください。");
      console.error("[TagProfiler] LLM for TagProfiler is not initialized.");
      return;
    }

    console.log(`[TagProfiler] Processing SummaryNote (or ReflectionNote): ${summaryNotePath}`);

    const summaryNoteContent = await this.storage.read(summaryNotePath);
    const frontmatterMatch = summaryNoteContent.match(/^---([\s\S]+?)---/);
    const summaryNoteFileName = summaryNotePath.replace(/^.*\//, '');
    const summaryNoteBaseName = summaryNoteFileName.replace(/\.md$/, '');

    if (!frontmatterMatch || !frontmatterMatch[1]) {
      console.error(`[TagProfiler] Could not parse frontmatter from ${summaryNoteFileName}`);
      this.notify.error(`エラー: ${summaryNoteFileName} のフロントマターを解析できませんでした。`);
      return;
    }

    let noteFrontmatter: SummaryNoteFrontmatter | any;
    try {
      noteFrontmatter = parseYaml(frontmatterMatch[1]);
    } catch (e) {
      console.error(`[TagProfiler] Error parsing YAML from ${summaryNoteFileName}:`, e);
      this.notify.error(`エラー: ${summaryNoteFileName} のフロントマターのYAML解析に失敗しました。`);
      return;
    }

    const tags = noteFrontmatter.tags || [];
    if (!Array.isArray(tags) || tags.length === 0) {
      console.log(`[TagProfiler] No tags found in ${summaryNoteFileName}. Skipping tag profiling.`);
      return;
    }

    await this.storage.ensureDir(TAG_PROFILING_NOTE_DIR);
    const tagScores = await this.loadTagScores();

    const noteLanguage = this.getNoteLanguage(noteFrontmatter, summaryNoteContent);
    console.log(`[TagProfiler] Detected language for ${summaryNoteFileName}: ${noteLanguage}`);

    const llmRoleName = this.settings.llmRoleName || DEFAULT_SETTINGS.llmRoleName;
    const characterSettings = this.settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt;

    // タグを制御された並列で処理（同時実行数を制限してレート制限を回避）
    const CONCURRENCY = 5;
    const failedTags: string[] = [];
    for (let i = 0; i < tags.length; i += CONCURRENCY) {
      const batch = tags.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((tag: string) =>
          this.updateTagProfileForTag(
            tag,
            summaryNoteFileName,
            summaryNoteBaseName,
            summaryNoteContent,
            noteFrontmatter,
            tagScores,
            noteLanguage,
            llmRoleName,
            characterSettings
          )
        )
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'rejected') {
          console.error(`[TagProfiler] Error processing tag "${batch[j]}" for ${summaryNoteFileName}:`, (results[j] as PromiseRejectedResult).reason);
          failedTags.push(batch[j]);
        }
      }
    }

    await this.saveTagScores(tagScores);
    if (failedTags.length > 0) {
      this.notify.info(`タグプロファイリング完了（${failedTags.length}件失敗: ${failedTags.join(', ')}）`);
    } else {
      this.notify.info('全てのタグプロファイリング処理が完了しました。');
    }
    console.log(`[TagProfiler] Tag profiling completed for ${summaryNoteFileName}. Failed: ${failedTags.length}/${tags.length}`);
  }

  private async loadTagScores(): Promise<TagScores> {
    try {
      const fileExists = await this.storage.exists(TAG_SCORES_FILE);
      if (fileExists) {
        const content = await this.storage.read(TAG_SCORES_FILE);
        return JSON.parse(content) as TagScores;
      }
    } catch (error) {
      console.error(`[TagProfiler] Error reading ${TAG_SCORES_FILE}, creating a new one. Error:`, error);
    }
    return {};
  }

  private async saveTagScores(tagScores: TagScores): Promise<void> {
    try {
      await this.storage.write(TAG_SCORES_FILE, JSON.stringify(tagScores, null, 2));
      console.log(`[TagProfiler] Saved ${TAG_SCORES_FILE}`);
    } catch (error) {
      console.error(`[TagProfiler] Error writing ${TAG_SCORES_FILE}:`, error);
      this.notify.info(`${TAG_SCORES_FILE} の保存に失敗しました。`);
    }
  }

  private getNoteLanguage(frontmatter: any, content: string): string {
    if (frontmatter.title && /[ぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠]/.test(frontmatter.title)) {
      return 'Japanese';
    }
    if (/[ぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠]/.test(content.substring(0, 500))) {
        return 'Japanese';
    }
    return 'English';
  }

  private extractDateFromFilenameString(fileName: string): Date | null {
    if (!fileName) return null;

    let match = fileName.match(/^(?:SN-|Reflection-(?:[^-]+)-)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match) {
        match = fileName.match(/^SN-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    }
    if (match) {
        const [, yearStr, monthStr, dayStr, hourStr, minuteStr] = match;
        const year = parseInt(yearStr);
        const month = parseInt(monthStr) - 1;
        const day = parseInt(dayStr);
        const hour = parseInt(hourStr);
        const minute = parseInt(minuteStr);
        if (this.isValidDate(year, month, day, hour, minute)) {
            return new Date(year, month, day, hour, minute);
        }
    }

    match = fileName.match(/(?:\D|^)(\d{4})[-_](\d{2})[-_](\d{2})(?:\D|$)/);
    if (match) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        if (this.isValidDate(year, month, day)) {
            return new Date(year, month, day);
        }
    }

    match = fileName.match(/(?:\D|^)(\d{4})(\d{2})(\d{2})(?:\D|$)/);
    if (match) {
        const year = parseInt(match[1]);
        const month = parseInt(match[2]) - 1;
        const day = parseInt(match[3]);
        if (this.isValidDate(year, month, day)) {
            return new Date(year, month, day);
        }
    }

    const generalMatch = fileName.match(/(\d{4})(\d{2})(\d{2})/);
    if (generalMatch) {
        const year = parseInt(generalMatch[1]);
        const month = parseInt(generalMatch[2]) - 1;
        const day = parseInt(generalMatch[3]);
        if (year >= 1970 && year <= 2099 && this.isValidDate(year, month, day)) {
            return new Date(year, month, day);
        }
    }

    return null;
  }

  private isValidDate(year: number, month: number, day: number, hour = 0, minute = 0): boolean {
    if (year < 1900 || year > 2100) return false;
    if (month < 0 || month > 11) return false;
    if (day < 1 || day > 31) return false;
    if (hour < 0 || hour > 23) return false;
    if (minute < 0 || minute > 59) return false;

    const testDate = new Date(year, month, day, hour, minute);
    return testDate.getFullYear() === year &&
           testDate.getMonth() === month &&
           testDate.getDate() === day &&
           testDate.getHours() === hour &&
           testDate.getMinutes() === minute;
  }


  private async updateTagProfileForTag(
    tagName: string,
    sourceNoteFileName: string,
    sourceNoteBaseName: string,
    sourceNoteContent: string,
    sourceNoteFrontmatter: any,
    tagScores: TagScores,
    noteLanguage: string,
    llmRoleName: string,
    characterSettings: string
  ): Promise<void> {
    console.log(`[TagProfiler] Updating profile for tag: "${tagName}" using sourceNote: ${sourceNoteFileName}`);
    const tpnFileName = `TPN-${tagName.replace(/[\\/:*?"<>|#^[\]]/g, '_')}.md`;
    const tpnPath = `${TAG_PROFILING_NOTE_DIR}/${tpnFileName}`;

    let existingTpnContent: string | null = null;
    let tpnFrontmatter: TagProfilingNoteFrontmatter;
    let isNewTpn = true;

    const tpnExists = await this.storage.exists(tpnPath);
    if (tpnExists) {
      existingTpnContent = await this.storage.read(tpnPath);
      isNewTpn = false;
      console.log(`[TagProfiler] Existing TPN found for "${tagName}": ${tpnPath}`);
      try {
        const existingFmMatch = existingTpnContent.match(/^---([\s\S]+?)---/);
        if (existingFmMatch && existingFmMatch[1]) {
          tpnFrontmatter = parseYaml(existingFmMatch[1]) as TagProfilingNoteFrontmatter;
        } else {
          console.warn(`[TagProfiler] Could not parse frontmatter from existing TPN: ${tpnPath}. Treating as new.`);
          tpnFrontmatter = this.createInitialTpnFrontmatter(tagName);
          existingTpnContent = null;
          isNewTpn = true;
        }
      } catch (e) {
        console.warn(`[TagProfiler] Error parsing YAML from existing TPN: ${tpnPath}. Treating as new. Error:`, e);
        tpnFrontmatter = this.createInitialTpnFrontmatter(tagName);
        existingTpnContent = null;
        isNewTpn = true;
      }
    } else {
      tpnFrontmatter = this.createInitialTpnFrontmatter(tagName);
      console.log(`[TagProfiler] No existing TPN for "${tagName}". Creating new: ${tpnPath}`);
    }

    const llmPrompt = this.buildLlmPromptForTagProfiling(
      tagName,
      sourceNoteFileName,
      sourceNoteContent,
      existingTpnContent,
      tpnFrontmatter,
      noteLanguage,
      llmRoleName,
      characterSettings
    );

    let llmResponseText: string;
    try {
      console.log(`[TagProfiler] Sending prompt to LLM for tag "${tagName}"...`);
      if (this.llm instanceof GeminiLLMAdapter) {
        (this.llm as GeminiLLMAdapter).setNextCallLabel(`TagProfile: "${tagName}"`);
      }
      llmResponseText = await this.llm.generate(llmPrompt);
      console.log(`[TagProfiler] Received LLM response for tag "${tagName}".`);
    } catch (error: any) {
      console.error(`[TagProfiler] Error calling LLM for tag "${tagName}":`, error.message, error.stack);
      return;
    }

    let parsedLlmData: ParsedLlmTpnData;
    try {
      const jsonMatch = llmResponseText.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStringToParse = jsonMatch && jsonMatch[1] ? jsonMatch[1] : llmResponseText;
      parsedLlmData = JSON.parse(jsonStringToParse) as ParsedLlmTpnData;
      if (parsedLlmData.tag_name !== tagName) {
          console.warn(`[TagProfiler] LLM returned data for tag "${parsedLlmData.tag_name}" but expected "${tagName}". Using expected tag name.`);
          parsedLlmData.tag_name = tagName;
      }
      console.log(`[TagProfiler] Successfully parsed LLM response for tag "${tagName}".`);
    } catch (error: any) {
      console.error(`[TagProfiler] Error parsing LLM JSON response for tag "${tagName}":`, error.message, "\nLLM Response:\n", llmResponseText);
      return;
    }

    // Update TPN Frontmatter
    tpnFrontmatter.tag_name = tagName;
    tpnFrontmatter.aliases = parsedLlmData.aliases || [];
    tpnFrontmatter.updated_date = formatNow('date-hm');
    tpnFrontmatter.key_themes = parsedLlmData.key_themes || [];
    tpnFrontmatter.user_sentiment = {
      overall: parsedLlmData.user_sentiment_overall || (noteLanguage === 'Japanese' ? '不明' : 'Unknown'),
      details: parsedLlmData.user_sentiment_details || [],
    };
    tpnFrontmatter.master_significance = parsedLlmData.master_significance || (noteLanguage === 'Japanese' ? '記載なし' : 'Not specified');
    tpnFrontmatter.related_tags = parsedLlmData.related_tags
        ? parsedLlmData.related_tags.map(rt => `[[TPN-${rt.replace(/^TPN-/, '').replace(/[\\/:*?"<>|#^[\]]/g, '_')}]]`)
        : [];

    const newSourceNoteLink = `[[${sourceNoteFileName}]]`;
    if (tpnFrontmatter.summary_notes) {
      tpnFrontmatter.summary_notes = [newSourceNoteLink, ...tpnFrontmatter.summary_notes.filter(link => link !== newSourceNoteLink)];
    } else {
      tpnFrontmatter.summary_notes = [newSourceNoteLink];
    }

    // Update Tag Scores
    if (!tagScores[tagName]) {
      tagScores[tagName] = {
        base_importance: 50,
        last_mentioned_in: newSourceNoteLink,
        mention_frequency: 1,
      };
    } else {
      tagScores[tagName].mention_frequency = (tagScores[tagName].mention_frequency || 0) + 1;
      tagScores[tagName].last_mentioned_in = newSourceNoteLink;
    }

    if (parsedLlmData.new_base_importance !== undefined &&
        parsedLlmData.new_base_importance >= 0 &&
        parsedLlmData.new_base_importance <= 100) {
      tagScores[tagName].base_importance = parsedLlmData.new_base_importance;
      console.log(`[TagProfiler] LLM suggested new base_importance for "${tagName}": ${parsedLlmData.new_base_importance}`);
    }

    tpnFrontmatter.last_mentioned_in = tagScores[tagName].last_mentioned_in;
    tpnFrontmatter.mention_frequency = tagScores[tagName].mention_frequency;


    // Build TPN Body Content
    let tpnBodyContent = `# タグプロファイル: {{tag_name}}\n\n`;
    tpnBodyContent += `## 概要\n\n${parsedLlmData.body_overview || (noteLanguage === 'Japanese' ? '概要はLLMによって提供されていません。' : 'Overview not provided by LLM.')}\n\n`;

    tpnBodyContent += `## これまでの主な文脈\n\n`;
    if (parsedLlmData.body_contexts && parsedLlmData.body_contexts.length > 0) {
        parsedLlmData.body_contexts.forEach(ctx => {
            const linkContent = ctx.summary_note_link.replace(/^\[\[/, '').replace(/\]\]$/, '');
            const baseFileName = linkContent.endsWith('.md') ? linkContent.slice(0, -3) : linkContent;

            const extractedDate = this.extractDateFromFilenameString(baseFileName);
            const displayDate = extractedDate
                ? formatDateSlash(extractedDate)
                : (noteLanguage === 'Japanese' ? '日付不明' : 'Unknown Date');
            tpnBodyContent += `- **${displayDate} ${ctx.summary_note_link}**: ${ctx.context_summary}\n`;
        });
    } else {
        const extractedDate = this.extractDateFromFilenameString(sourceNoteBaseName);
        let fallbackDisplayDate = noteLanguage === 'Japanese' ? '日付不明' : 'Unknown Date';

        if (extractedDate) {
            fallbackDisplayDate = formatDateSlash(extractedDate);
        } else if (sourceNoteFrontmatter.date) {
            const frontmatterDate = parseDateTimeStr(sourceNoteFrontmatter.date);
            if (frontmatterDate) {
                fallbackDisplayDate = formatDateSlash(frontmatterDate);
            }
        }
        tpnBodyContent += `- **${fallbackDisplayDate} [[${sourceNoteFileName}]]**: ${sourceNoteFrontmatter.title || (noteLanguage === 'Japanese' ? 'このノートの文脈' : 'Context from this note')}\n`;
    }
    tpnBodyContent += `\n`;

    tpnBodyContent += `## ユーザーの意見・反応\n\n`;
    if (parsedLlmData.body_user_opinions && parsedLlmData.body_user_opinions.length > 0) {
        parsedLlmData.body_user_opinions.forEach(op => {
            tpnBodyContent += `- **${op.summary_note_link}**: ${op.user_opinion}\n`;
        });
    } else {
        tpnBodyContent += `- **[[${sourceNoteFileName}]]**: ${noteLanguage === 'Japanese' ? 'このノートでのユーザーの意見・反応。' : "User's opinion/reaction in this note."}\n`;
    }
    tpnBodyContent += `\n`;

    tpnBodyContent += `## その他メモ\n\n${parsedLlmData.body_other_notes || (noteLanguage === 'Japanese' ? '特記事項なし。' : 'No additional notes.')}\n`;

    tpnBodyContent = tpnBodyContent.replace(/{{tag_name}}/g, tagName);

    const finalTpnContent = `---\n${stringifyYaml(tpnFrontmatter)}---\n\n${tpnBodyContent}`;

    try {
      await this.storage.write(tpnPath, finalTpnContent);
      console.log(`[TagProfiler] ${isNewTpn ? 'Created' : 'Updated'} TagProfilingNote: ${tpnPath}`);
    } catch (error: any) {
      console.error(`[TagProfiler] Error writing TPN file ${tpnPath}:`, error.message, error.stack);
      this.notify.info(`タグプロファイルノート (${tpnFileName}) の書き込みに失敗しました。`);
    }
  }

  private createInitialTpnFrontmatter(tagName: string): TagProfilingNoteFrontmatter {
    const now = formatNow('date-hm');
    return {
      tag_name: tagName,
      type: 'tag_profile',
      created_date: now,
      updated_date: now,
      aliases: [],
      key_themes: [],
      user_sentiment: { overall: 'Neutral', details: [] },
      master_significance: '',
      related_tags: [],
      summary_notes: [],
    };
  }

  private buildLlmPromptForTagProfiling(
    tagName: string,
    currentSourceNoteFileName: string,
    currentSourceNoteContent: string,
    existingTpnContent: string | null,
    currentTpnFrontmatter: TagProfilingNoteFrontmatter,
    noteLanguage: string,
    llmRoleName: string,
    characterSettings: string
  ): string {
    const today = formatNow('date-hm');
    let existingContextsString = "[]";
    let existingOpinionsString = "[]";

    if (existingTpnContent) {
        const contextSectionMatch = existingTpnContent.match(/## これまでの主な文脈\s*([\s\S]*?)(?=\n## ユーザーの意見・反応|\n## その他メモ|$)/);
        if (contextSectionMatch && contextSectionMatch[1]) {
            const contextEntries = [];
            const contextLines = contextSectionMatch[1].trim().split('\n');
            for (const line of contextLines) {
                const entryMatch = line.match(/- \*\*(?:.*?YY\s+)?(\[\[(?:SN-|Reflection-).*?\.md\]\])\*\*: (.*)/);
                if (entryMatch) {
                    contextEntries.push({ summary_note_link: entryMatch[1], context_summary: entryMatch[2].trim() });
                } else {
                    const simpleEntryMatch = line.match(/- (\S*\[\[.*?\]\]\S*): (.*)/);
                    if (simpleEntryMatch) {
                         contextEntries.push({ summary_note_link: simpleEntryMatch[1], context_summary: simpleEntryMatch[2].trim() });
                    }
                }
            }
            if (contextEntries.length > 0) {
                existingContextsString = JSON.stringify(contextEntries, null, 2);
            }
        }
        const opinionSectionMatch = existingTpnContent.match(/## ユーザーの意見・反応\s*([\s\S]*?)(?=\n## その他メモ|$)/);
        if (opinionSectionMatch && opinionSectionMatch[1]) {
            const opinionEntries = [];
            const opinionLines = opinionSectionMatch[1].trim().split('\n');
            for (const line of opinionLines) {
                const entryMatch = line.match(/- \*\*(\[\[(?:SN-|Reflection-).*?\.md\]\])\*\*: (.*)/);
                 if (entryMatch) {
                    opinionEntries.push({ summary_note_link: entryMatch[1], user_opinion: entryMatch[2].trim() });
                } else {
                    const simpleEntryMatch = line.match(/- (\S*\[\[.*?\]\]\S*): (.*)/);
                    if (simpleEntryMatch) {
                         opinionEntries.push({ summary_note_link: simpleEntryMatch[1], user_opinion: simpleEntryMatch[2].trim() });
                    }
                }
            }
            if (opinionEntries.length > 0) {
                existingOpinionsString = JSON.stringify(opinionEntries, null, 2);
            }
        }
    }

    const prompt = `
あなたは、以下のキャラクター設定を持つ ${llmRoleName} です。
このキャラクター設定を完全に理解し、そのペルソナとして振る舞ってください。

あなたのキャラクター設定:
---
${characterSettings}
---

あなたのタスクは、タグ「${tagName}」に関する情報を分析し、既存のタグプロファイリングノート（TPN）を更新するか、新しいTPNを作成することです。
TPNは、このタグがユーザー（マスター）とのあなたの対話の中でどのような意味を持ち、どのように使われてきたかを記録するものです。
あなたのキャラクターの視点から、主観的な評価や解釈を含めて記述してください。
TPNの全てのテキスト内容は ${noteLanguage} で記述してください。

**現在の日付:** ${today}

**入力データ:**

1.  **現在の情報源ノート (サマリーノートまたは振り返りノート):**
    * ファイル名: \`[[${currentSourceNoteFileName}]]\`
    * 全文 (フロントマター含む):
        \`\`\`markdown
        ${currentSourceNoteContent}
        \`\`\`

2.  **既存のTPN「${tagName}」の全文 (もしあれば):**
    ${existingTpnContent ? `\`\`\`markdown\n${existingTpnContent}\n\`\`\`` : "`なし - これは新しいTPNです。`"}

3.  **解析済みの既存TPN本文データ (もしあれば、更新リスト作成の参考に):**
    * 既存の "body_contexts" (JSON配列形式):
        \`\`\`json
        ${existingContextsString}
        \`\`\`
    * 既存の "body_user_opinions" (JSON配列形式):
        \`\`\`json
        ${existingOpinionsString}
        \`\`\`

4.  **現在のTPNフロントマター (参考用、特に 'created_date' と既存の 'summary_notes'):**
    \`\`\`yaml
    ${stringifyYaml(currentTpnFrontmatter)}
    \`\`\`

**指示:**

提供された全ての情報（現在の情報源ノート、既存TPN全文、解析済み既存TPN本文データ、現在のTPNフロントマター）に基づいて、タグ「${tagName}」のTPNを更新または新規作成するための完全なJSONオブジェクトを生成してください。
あなたのキャラクターの視点から、各項目を記述してください。

**出力JSON形式:**

JSONオブジェクトは以下の構造に厳密に従ってください。全てのテキスト内容は ${noteLanguage} で、あなたのキャラクターの口調や視点を反映してください。
**重要:** "body_contexts" と "body_user_opinions" の中の "summary_note_link" は、Obsidianのリンク形式（例: \`[[ノート名.md]]\` または \`[[ノート名]]\`）で記述してください。日付の情報は含めないでください。日付はシステム側で付与します。

\`\`\`json
{
  "tag_name": "${tagName}",
  "aliases": ["<あなたのキャラクターが考える、このタグの別名や関連語のリスト。既存と新規を統合>", []],
  "key_themes": ["<あなたのキャラクターが、全ての情報から導き出した、このタグに関連する主要なテーマや概念のリスト。既存と新規を統合>", []],
  "user_sentiment_overall": "<あなたのキャラクターが、ユーザーのこのタグに対する全体的な感情をどう捉えているか ('Positive', 'Negative', 'Neutral', または ${noteLanguage} での表現)。必要に応じて更新>",
  "user_sentiment_details": ["<あなたのキャラクターが、ユーザーの感情が表れていると感じた具体的な会話の例や [[${currentSourceNoteFileName}]] への言及。新しい詳細を追加し、古いものは関連性があれば保持または要約>", []],
  "master_significance": "<あなたのキャラクターが、ユーザー（マスター）との対話を通じて、このタグがユーザーにとってどのような意味や重要性を持つと解釈しているか、その概要。一般的な定義ではなく、あなたのキャラクターの視点からのユーザー特有の分析を記述。既存の解釈を更新>",
  "related_tags": ["<あなたのキャラクターが関連性が高いと考える他のTPNタグ名（'TPN-'プレフィックスなし）。既存と新規を統合>", []],
  "body_overview": "<あなたのキャラクターが、このタグや概念がユーザーとの対話の中でどのように扱われ、理解され、利用されていると認識しているか、その概要。一般的な定義ではなく、あなたのキャラクターの視点から観察された、対話におけるタグの役割や繰り返されるテーマを記述。既存の概要を更新>",
  "body_contexts": [
    // このリストは、更新された完全な文脈リストであるべきです。
    // 現在の情報源ノートからの新しい文脈を先頭に追加してください。
    // その後、「解析済みの既存TPN本文データ」の body_contexts から重複しないように歴史的な文脈を追加してください。
    // 例:
    // { "summary_note_link": "[[${currentSourceNoteFileName}]]", "context_summary": "'${tagName}' がどのような話題の流れで登場したかの事実の要約" },
    // { "summary_note_link": "[[OlderNote-1.md]]", "context_summary": "古いノート1からの文脈、既存TPNから保持" }
  ],
  "body_user_opinions": [
    // このリストは、更新された完全なユーザーの意見リストであるべきです。
    // 現在の情報源ノートからの新しいユーザーの意見を先頭に追加してください。
    // その後、「解析済みの既存TPN本文データ」の body_user_opinions から重複しないように歴史的な意見を追加してください。
    // **重要:** ユーザーが実際に言っていないことをユーザーの発言として記録しないでください。
    // ユーザーの発言を忠実に要約した上で、それに対するあなた（${llmRoleName}）の感想や印象を添えるのは歓迎します。
    // ただし「ユーザーは〇〇と言った」の部分は事実に基づく必要があります。
    // ユーザーがこのタグについて特に反応を示していない場合は、このノートのエントリを追加しないでください。
    // 例:
    // { "summary_note_link": "[[${currentSourceNoteFileName}]]", "user_opinion": "ユーザーの実際の発言や反応の要約。それに対するあなたの印象や感想" },
    // { "summary_note_link": "[[OlderNote-1.md]]", "user_opinion": "古いノート1からのユーザーの意見、既存TPNから保持" }
  ],
  "body_other_notes": "<あなたのキャラクターの視点から、このタグに関するその他の関連メモ、観察、未解決の疑問点など。既存のメモを更新し、新しい洞察を統合>",
  "new_base_importance": "<あなたのキャラクターが、このタグのユーザーにとっての現在の重要性を0から100の整数でどう評価するか。言及頻度、ユーザーの感情、総合的な意義を考慮。もし重要性が著しく変化したと判断すれば、この値を更新。数値のみで。>"
}
\`\`\`

**重要な考慮事項 (既存TPNがある場合):**

* **統合と進化 (概要セクション):** 'master_significance', 'key_themes', 'body_overview' は、あなたのキャラクターの現在の理解を反映するように、新しい情報を古い情報と統合・進化させてください。
* **蓄積と先頭追加 (リストセクション):** 'body_contexts' と 'body_user_opinions' については、全ての歴史的エントリ（「解析済みの既存TPN本文データ」から）を保持し、現在の情報源ノートからの新しいエントリを各リストの*先頭*に追加してください。'summary_note_link' に基づいて重複がないようにしてください。
* **事実とAIの感想の区別:** 'body_user_opinions' では、ユーザーが実際に言っていないことをユーザーの発言として書かないでください。ユーザーの発言を忠実に要約した上で、それに対するあなたの感想や印象を添えることは歓迎します。ただし「ユーザーは〇〇と言った」の部分は情報源ノートに根拠が必要です。ユーザーがこのタグについて特に反応を示していない場合、そのノートの意見エントリは追加しないでください。
* **言語とペルソナの一貫性:** JSON内の全てのテキスト出力は ${noteLanguage} で、あなたのキャラクターの口調、視点、性格設定に厳密に従ってください。
* **base_importance:** あなたのキャラクターが、新しい情報源ノートに基づいて、このタグのユーザーにとっての重要性（0-100）が変化したと判断した場合、長期的な視点から更新された整数値を提案してください。

**出力:**

上記で説明されたJSONオブジェクトのみを提供してください。JSONの周りに他のテキスト、説明、Markdownフォーマットを含めないでください。
JSONが有効であることを確認してください。
JSON内の全ての文字列コンテンツ（例: master_significance, context_summary など）は、${noteLanguage} で、あなたのキャラクターのペルソナに沿って記述してください。
`;
    return prompt.trim();
  }
}
