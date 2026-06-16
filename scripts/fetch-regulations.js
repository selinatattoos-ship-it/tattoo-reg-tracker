import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser = new Parser();

async function classifyEntry(title, content) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are a regulatory analyst specializing in tattoo products (inks, needles, aftercare).

Analyze this regulatory feed entry and return ONLY a JSON object with no markdown or extra text:

Title: ${title}
Content: ${content}

Return this exact JSON structure:
{
  "is_relevant": true or false,
  "title": "clean title",
  "summary": "2-3 sentence plain english summary",
  "product_types": ["ink", "needle", "aftercare", "equipment", "other"],
  "ingredients": ["any flagged ingredients mentioned"],
  "status": "active" or "proposed" or "under_review" or "repealed",
  "severity": "ban" or "restriction" or "warning" or "informational",
  "effective_date": "YYYY-MM-DD or null"
}`
    }]
  });

  try {
    const text = message.content[0].text.trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function processFeed(source) {
  console.log(`Fetching: ${source.name}`);
  
  let feed;
  try {
    feed = await parser.parseURL(source.url);
  } catch (err) {
    console.error(`Failed to fetch ${source.name}:`, err.message);
    return;
  }

  for (const item of feed.items.slice(0, 10)) {
    const externalId = item.guid || item.link || item.title;

    // Skip if already processed
    const { data: existing } = await supabase
      .from('raw_feed_entries')
      .select('id')
      .eq('source_id', source.id)
      .eq('external_id', externalId)
      .single();

    if (existing) continue;

    const content = item.contentSnippet || item.content || item.summary || '';

    // Save raw entry
    const { data: rawEntry } = await supabase
      .from('raw_feed_entries')
      .insert({
        source_id: source.id,
        external_id: externalId,
        title: item.title,
        content: content,
        published_at: item.pubDate ? new Date(item.pubDate) : null,
        url: item.link,
        processed: false
      })
      .select()
      .single();

    if (!rawEntry) continue;

    // Classify with Claude
    console.log(`  Classifying: ${item.title}`);
    const classification = await classifyEntry(item.title, content);

  if (!classification || false) {
      console.log(`  Skipping (not relevant)`);
      await supabase
        .from('raw_feed_entries')
        .update({ processed: true })
        .eq('id', rawEntry.id);
      continue;
    }

    // Save regulation
    const { data: regulation } = await supabase
      .from('regulations')
      .insert({
        title: classification.title || item.title,
        summary: classification.summary,
        region_id: source.region_id,
        source_id: source.id,
        product_types: classification.product_types || [],
        ingredients: classification.ingredients || [],
        status: classification.status || 'active',
        severity: classification.severity || 'informational',
        effective_date: classification.effective_date || null,
        source_url: item.link,
        external_id: externalId
      })
      .select()
      .single();

    if (regulation) {
      // Log the change
      await supabase.from('regulation_changes').insert({
        regulation_id: regulation.id,
        change_type: 'created',
        new_status: regulation.status,
        summary: classification.summary
      });

      // Mark raw entry as processed
      await supabase
        .from('raw_feed_entries')
        .update({ processed: true, regulation_id: regulation.id })
        .eq('id', rawEntry.id);

      console.log(`  Saved: ${regulation.title}`);
    }
  }

  // Update last fetched time
  await supabase
    .from('sources')
    .update({ last_fetched_at: new Date() })
    .eq('id', source.id);
}

async function main() {
  console.log('Starting regulation fetch...');

  const { data: sources, error } = await supabase
    .from('sources')
    .select('*')
    .eq('active', true)
    .eq('type', 'rss');

  if (error || !sources?.length) {
    console.error('No active RSS sources found');
    return;
  }

  for (const source of sources) {
    await processFeed(source);
  }

  console.log('Done!');
}

main().catch(console.error);
