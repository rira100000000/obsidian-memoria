// src/tagProfiler.ts
import { App, Notice, TFile, moment, stringifyYaml, parseYaml } from 'obsidian';
import ObsidianMemoria from '../main';
import { GeminiPluginSettings } from './settings';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage } from "@langchain/core/messages";
import {
  TagScoreEntry,
  TagScores,
  TagProfilingNoteFrontmatter,
  ParsedLlmTpnData,
  SummaryNoteFrontmatter
} from './types'; // 型定義をインポート

const TAG_PROFILING_NOTE_DIR = 'TagProfilingNote';
const TAG_SCORES_FILE = 'tag_scores.json';

export class TagProfiler {
  private plugin: ObsidianMemoria;
  private app: App;
  private settings: GeminiPluginSettings;
  private chatModel: ChatGoogleGenerativeAI | null = null;

  constructor(plugin: ObsidianMemoria) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;
    this.initializeChatModel();
  }

  private initializeChatModel() {
    if (this.settings.geminiApiKey && this.settings.geminiModel) {
      try {
        this.chatModel = new ChatGoogleGenerativeAI({
          apiKey: this.settings.geminiApiKey,
          model: this.settings.geminiModel,
        });
        console.log('[TagProfiler] ChatGoogleGenerativeAI model initialized.');
      } catch (error: any) {
        console.error("[TagProfiler] Failed to initialize ChatGoogleGenerativeAI model:", error.message);
        this.chatModel = null;
      }
    } else {
      console.log('[TagProfiler] API key or model name not set. LLM not initialized for TagProfiler.');
      this.chatModel = null;
    }
  }

  public onSettingsChanged() {
    this.settings = this.plugin.settings;
    this.initializeChatModel();
    console.log('[TagProfiler] Settings changed, chat model re-initialized.');
  }

  public async processSummaryNote(summaryNoteFile: TFile): Promise<void> {
    if (!this.chatModel) {
      new Notice("タグプロファイリング: LLMが初期化されていません。設定を確認してください。");
      console.error("[TagProfiler] LLM for TagProfiler is not initialized.");
      return;
    }

    console.log(`[TagProfiler] Processing SummaryNote: ${summaryNoteFile.path}`);

    const summaryNoteContent = await this.app.vault.cachedRead(summaryNoteFile);
    const frontmatterMatch = summaryNoteContent.match(/^---([\s\S]+?)---/);
    if (!frontmatterMatch || !frontmatterMatch[1]) {
      console.error(`[TagProfiler] Could not parse frontmatter from ${summaryNoteFile.name}`);
      new Notice(`エラー: ${summaryNoteFile.name} のフロントマターを解析できませんでした。`);
      return;
    }

    let summaryNoteFrontmatter: SummaryNoteFrontmatter;
    try {
      summaryNoteFrontmatter = parseYaml(frontmatterMatch[1]) as SummaryNoteFrontmatter;
    } catch (e) {
      console.error(`[TagProfiler] Error parsing YAML from ${summaryNoteFile.name}:`, e);
      new Notice(`エラー: ${summaryNoteFile.name} のフロントマターのYAML解析に失敗しました。`);
      return;
    }

    const tags = this.extractTagsFromSummaryNote(summaryNoteFrontmatter);
    if (!tags || tags.length === 0) {
      console.log(`[TagProfiler] No tags found in ${summaryNoteFile.name}. Skipping tag profiling.`);
      return;
    }

    await this.ensureDirectoryExists(TAG_PROFILING_NOTE_DIR);
    const tagScores = await this.loadTagScores();

    const summaryNoteLanguage = await this.getSummaryNoteLanguage(summaryNoteFrontmatter, summaryNoteContent);
    console.log(`[TagProfiler] Detected language for ${summaryNoteFile.name}: ${summaryNoteLanguage}`);

    const processingPromises = tags.map(tag =>
      this.updateTagProfileForTag(tag, summaryNoteFile, summaryNoteContent, summaryNoteFrontmatter, tagScores, summaryNoteLanguage)
        .catch(err => {
          console.error(`[TagProfiler] Error processing tag "${tag}" for ${summaryNoteFile.name}:`, err);
        })
    );

    try {
      await Promise.all(processingPromises);
      await this.saveTagScores(tagScores);
      new Notice('全てのタグプロファイリング処理が完了しました。');
      console.log(`[TagProfiler] All tag profiling processes completed for ${summaryNoteFile.name}.`);
    } catch (error) {
      console.error('[TagProfiler] Unexpected error during Promise.all for tag processing:', error);
      new Notice('タグプロファイリング処理中に予期せぬエラーが発生しました。');
    }
  }

  private extractTagsFromSummaryNote(frontmatter: SummaryNoteFrontmatter): string[] {
    return frontmatter.tags || [];
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      const dirExists = await this.app.vault.adapter.exists(dirPath);
      if (!dirExists) {
        await this.app.vault.createFolder(dirPath);
        console.log(`[TagProfiler] Created directory: ${dirPath}`);
      }
    } catch (error: any) {
      console.error(`[TagProfiler] Error creating directory ${dirPath}:`, error.message);
      new Notice(`${dirPath} ディレクトリの作成に失敗しました。`);
    }
  }

  private async loadTagScores(): Promise<TagScores> {
    try {
      const fileExists = await this.app.vault.adapter.exists(TAG_SCORES_FILE);
      if (fileExists) {
        const content = await this.app.vault.adapter.read(TAG_SCORES_FILE);
        return JSON.parse(content) as TagScores;
      }
    } catch (error) {
      console.error(`[TagProfiler] Error reading ${TAG_SCORES_FILE}, creating a new one. Error:`, error);
    }
    return {};
  }

  private async saveTagScores(tagScores: TagScores): Promise<void> {
    try {
      await this.app.vault.adapter.write(TAG_SCORES_FILE, JSON.stringify(tagScores, null, 2));
      console.log(`[TagProfiler] Saved ${TAG_SCORES_FILE}`);
    } catch (error) {
      console.error(`[TagProfiler] Error writing ${TAG_SCORES_FILE}:`, error);
      new Notice(`${TAG_SCORES_FILE} の保存に失敗しました。`);
    }
  }

  private async getSummaryNoteLanguage(frontmatter: SummaryNoteFrontmatter, content: string): Promise<string> {
    if (frontmatter.title && /[ぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠]/.test(frontmatter.title)) {
      return 'Japanese';
    }
    return 'English';
  }


  private async updateTagProfileForTag(
    tagName: string,
    summaryNoteFile: TFile,
    summaryNoteContent: string,
    summaryNoteFrontmatter: SummaryNoteFrontmatter,
    tagScores: TagScores,
    summaryNoteLanguage: string
  ): Promise<void> {
    // Guard clause for chatModel, though processSummaryNote should already ensure it's not null.
    // This satisfies the TypeScript compiler for the current scope.
    if (!this.chatModel) {
      console.error("[TagProfiler] chatModel is unexpectedly null in updateTagProfileForTag. Aborting tag processing for:", tagName);
      new Notice(`タグ「${tagName}」の処理中に内部エラーが発生しました (LLMモデル未初期化)。`);
      return;
    }

    console.log(`[TagProfiler] Updating profile for tag: "${tagName}" using SummaryNote: ${summaryNoteFile.name}`);
    const tpnFileName = `TPN-${tagName.replace(/[\\/:*?"<>|#^[\]]/g, '_')}.md`;
    const tpnPath = `${TAG_PROFILING_NOTE_DIR}/${tpnFileName}`;

    let existingTpnContent: string | null = null;
    let tpnFrontmatter: TagProfilingNoteFrontmatter;
    let isNewTpn = true;

    const tpnFile = this.app.vault.getAbstractFileByPath(tpnPath);
    if (tpnFile instanceof TFile) {
      existingTpnContent = await this.app.vault.cachedRead(tpnFile);
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
      summaryNoteFile.name,
      summaryNoteContent,
      existingTpnContent,
      tpnFrontmatter,
      summaryNoteLanguage
    );

    let llmResponseText: string;
    try {
      console.log(`[TagProfiler] Sending prompt to LLM for tag "${tagName}"...`);
      // Now that chatModel is confirmed to be non-null in this scope, we can safely call invoke.
      const response = await this.chatModel.invoke([new HumanMessage(llmPrompt)]);
      if (typeof response.content !== 'string') {
        throw new Error("LLM response content is not a string.");
      }
      llmResponseText = response.content;
      console.log(`[TagProfiler] Received LLM response for tag "${tagName}".`);
    } catch (error: any) {
      console.error(`[TagProfiler] Error calling LLM for tag "${tagName}":`, error.message, error.stack);
      new Notice(`タグ「${tagName}」のプロファイル生成中にLLMエラーが発生しました。`);
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
      new Notice(`タグ「${tagName}」のLLM応答解析に失敗しました。詳細はコンソールを確認してください。`);
      return;
    }

    tpnFrontmatter.tag_name = tagName;
    tpnFrontmatter.aliases = parsedLlmData.aliases || [];
    tpnFrontmatter.updated_date = moment().format('YYYY-MM-DD HH:MM');
    tpnFrontmatter.key_themes = parsedLlmData.key_themes || [];
    tpnFrontmatter.user_sentiment = {
      overall: parsedLlmData.user_sentiment_overall || (summaryNoteLanguage === 'Japanese' ? '不明' : 'Unknown'),
      details: parsedLlmData.user_sentiment_details || [],
    };
    tpnFrontmatter.master_significance = parsedLlmData.master_significance || (summaryNoteLanguage === 'Japanese' ? '記載なし' : 'Not specified');
    tpnFrontmatter.related_tags = parsedLlmData.related_tags ? parsedLlmData.related_tags.map(rt => `[[TPN-${rt.replace(/^TPN-/, '')}]]`) : [];


    const newSummaryNoteLink = `[[${summaryNoteFile.name}]]`;
    if (tpnFrontmatter.summary_notes) {
      tpnFrontmatter.summary_notes = [newSummaryNoteLink, ...tpnFrontmatter.summary_notes.filter(link => link !== newSummaryNoteLink)];
    } else {
      tpnFrontmatter.summary_notes = [newSummaryNoteLink];
    }

    if (!tagScores[tagName]) {
      tagScores[tagName] = {
        base_importance: 50,
        last_mentioned_in: newSummaryNoteLink,
        mention_frequency: 1,
      };
    } else {
      tagScores[tagName].mention_frequency = (tagScores[tagName].mention_frequency || 0) + 1;
      tagScores[tagName].last_mentioned_in = newSummaryNoteLink;
    }

    if (parsedLlmData.new_base_importance !== undefined &&
        parsedLlmData.new_base_importance >= 0 &&
        parsedLlmData.new_base_importance <= 100) {
      tagScores[tagName].base_importance = parsedLlmData.new_base_importance;
      console.log(`[TagProfiler] LLM suggested new base_importance for "${tagName}": ${parsedLlmData.new_base_importance}`);
    }

    tpnFrontmatter.last_mentioned_in = tagScores[tagName].last_mentioned_in;
    tpnFrontmatter.mention_frequency = tagScores[tagName].mention_frequency;

    let tpnBodyContent = `# タグプロファイル: {{tag_name}}\n\n`;
    tpnBodyContent += `## 概要\n\n${parsedLlmData.body_overview || (summaryNoteLanguage === 'Japanese' ? '記載なし' : 'Not specified')}\n\n`;

    tpnBodyContent += `## これまでの主な文脈\n\n`;
    if (parsedLlmData.body_contexts && parsedLlmData.body_contexts.length > 0) {
        parsedLlmData.body_contexts.forEach(ctx => {
            const datePart = ctx.summary_note_link.match(/SN-(\d{8})\d{4}-/);
            const displayDate = datePart ? moment(datePart[1], "YYYYMMDD").format("YYYY/MM/DD") : "不明な日付";
            tpnBodyContent += `- **${displayDate} ${ctx.summary_note_link}**: ${ctx.context_summary}\n`;
        });
    } else {
        const datePart = summaryNoteFile.name.match(/SN-(\d{8})\d{4}-/);
        const displayDate = datePart ? moment(datePart[1], "YYYYMMDD").format("YYYY/MM/DD") : "不明な日付";
        tpnBodyContent += `- **${displayDate} [[${summaryNoteFile.name}]]**: ${summaryNoteFrontmatter.title || 'タイトルなし'}\n`;
    }
    tpnBodyContent += `\n`;

    tpnBodyContent += `## ユーザーの意見・反応\n\n`;
    if (parsedLlmData.body_user_opinions && parsedLlmData.body_user_opinions.length > 0) {
        parsedLlmData.body_user_opinions.forEach(op => {
            tpnBodyContent += `- **${op.summary_note_link}**: ${op.user_opinion}\n`;
        });
    } else {
         tpnBodyContent += `- **[[${summaryNoteFile.name}]]**: この会話での具体的なユーザーの意見はLLMにより抽出・記載されます。\n`;
    }
    tpnBodyContent += `\n`;

    tpnBodyContent += `## その他メモ\n\n${parsedLlmData.body_other_notes || (summaryNoteLanguage === 'Japanese' ? '特記事項なし' : 'No additional notes.')}\n`;

    tpnBodyContent = tpnBodyContent.replace(/{{tag_name}}/g, tagName);

    const finalTpnContent = `---\n${stringifyYaml(tpnFrontmatter)}---\n\n${tpnBodyContent}`;

    try {
      if (isNewTpn) {
        await this.app.vault.create(tpnPath, finalTpnContent);
        console.log(`[TagProfiler] Created TagProfilingNote: ${tpnPath}`);
      } else {
        await this.app.vault.modify(tpnFile as TFile, finalTpnContent);
        console.log(`[TagProfiler] Updated TagProfilingNote: ${tpnPath}`);
      }
    } catch (error: any) {
      console.error(`[TagProfiler] Error writing TPN file ${tpnPath}:`, error.message, error.stack);
      new Notice(`タグプロファイルノート (${tpnFileName}) の書き込みに失敗しました。`);
    }
  }

  private createInitialTpnFrontmatter(tagName: string): TagProfilingNoteFrontmatter {
    const now = moment().format('YYYY-MM-DD HH:MM');
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
    currentSummaryNoteFileName: string,
    currentSummaryNoteContent: string,
    existingTpnContent: string | null,
    currentTpnFrontmatter: TagProfilingNoteFrontmatter,
    noteLanguage: string
  ): string {
    const today = moment().format('YYYY-MM-DD HH:MM');
    // プロンプト内容は変更なしのため、ここでは省略します。
    // 実際のコードでは、前のバージョンのプロンプトがここに存在します。
    const prompt = `
You are an AI assistant specializing in knowledge management and text analysis within Obsidian.
Your task is to create or update a Tag Profiling Note (TPN) for the tag "${tagName}".
The TPN should be written in ${noteLanguage}.

**Current Date:** ${today}

**Input Data:**

1.  **Current Summary Note (SN):**
    * File Name: \`[[${currentSummaryNoteFileName}]]\`
    * Full Content (including frontmatter):
        \`\`\`markdown
        ${currentSummaryNoteContent}
        \`\`\`

2.  **Existing Tag Profiling Note (TPN) for "${tagName}" (if available):**
    ${existingTpnContent ? `\`\`\`markdown\n${existingTpnContent}\n\`\`\`` : "`None - This is a new TPN.`"}

3.  **Current TPN Frontmatter (for reference, especially for 'created_date' and existing 'summary_notes'):**
    \`\`\`yaml
    ${stringifyYaml(currentTpnFrontmatter)}
    \`\`\`

**Instructions:**

Based on ALL the provided information (Current SN, Existing TPN, Current TPN Frontmatter), generate a complete JSON object that represents the *updated* or *new* Tag Profiling Note for "${tagName}".
The TPN helps understand the meaning, context, and importance of this tag over time.
When updating, consider the existing TPN content as historical fact and integrate the new information from the Current SN to reflect the *current* understanding and significance of the tag.

**Output JSON Format:**

The JSON object MUST follow this structure precisely. All textual content MUST be in ${noteLanguage}.

\`\`\`json
{
  "tag_name": "${tagName}",
  "aliases": ["<list of aliases or related terms in ${noteLanguage}>"],
  "key_themes": ["<list of key themes/concepts related to this tag, derived from all available info, in ${noteLanguage}>"],
  "user_sentiment_overall": "<'Positive', 'Negative', 'Neutral', or ${noteLanguage} equivalent, based on overall user interactions related to this tag>",
  "user_sentiment_details": ["<specific examples or links to conversations showing sentiment, e.g., 'User expressed excitement in [[${currentSummaryNoteFileName}]] about X', in ${noteLanguage}>"],
  "master_significance": "<a comprehensive overview of what this tag means to the user (master) and its importance, reflecting the latest understanding from the Current SN and history, in ${noteLanguage}>",
  "related_tags": ["<list of other relevant TPN tag names (without 'TPN-' prefix), e.g., 'RelatedTag1', 'AnotherConcept', in ${noteLanguage}>"],
  "body_overview": "<a definition or general overview of the tag, in ${noteLanguage}>",
  "body_contexts": [
    {
      "summary_note_link": "[[${currentSummaryNoteFileName}]]",
      "context_summary": "<briefly describe the context in which '${tagName}' appeared in the Current SN, in ${noteLanguage}>"
    }
  ],
  "body_user_opinions": [
    {
      "summary_note_link": "[[${currentSummaryNoteFileName}]]",
      "user_opinion": "<describe user's opinion/reaction regarding '${tagName}' in the Current SN, in ${noteLanguage}>"
    }
  ],
  "body_other_notes": "<any other relevant notes or observations about this tag, in ${noteLanguage}>",
  "new_base_importance": "<integer between 0-100, representing your assessment of the tag's current importance. Consider its frequency, user sentiment, and overall significance. If unsure, provide the current importance from tag_scores.json or a default like 50. This is a long-term perspective. If the tag's importance has significantly changed, update this value.>"
}
\`\`\`

**Important Considerations for Updating (if existing TPN is provided):**

* **Evolution of Meaning:** The 'master_significance', 'key_themes', and 'body_overview' should evolve. Don't just append; synthesize the information.
* **Historical Context:** 'body_contexts' and 'body_user_opinions' should accumulate. Add new entries from the Current SN. You can summarize or rephrase older entries if it improves clarity, but retain the historical link.
* **base_importance:** Evaluate if the tag's importance (0-100) has changed based on the new SN. Provide an updated integer value if a change is warranted from a long-term perspective.

**Output:**

Provide ONLY the JSON object described above. Do not include any other text, explanations, or markdown formatting around the JSON.
Ensure the JSON is valid.
All string content within the JSON (e.g., master_significance, context_summary, etc.) MUST be in ${noteLanguage}.
`;
    return prompt.trim();
  }
}
