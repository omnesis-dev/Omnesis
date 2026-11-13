// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.TokenStream;
import org.apache.lucene.analysis.miscellaneous.PerFieldAnalyzerWrapper;
import org.apache.lucene.analysis.standard.StandardAnalyzer;
import org.apache.lucene.analysis.tokenattributes.CharTermAttribute;
import org.apache.lucene.analysis.tokenattributes.OffsetAttribute;
import org.apache.lucene.analysis.tokenattributes.PositionIncrementAttribute;
import org.apache.lucene.analysis.tokenattributes.PositionLengthAttribute;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.similarities.BM25Similarity;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.util.QueryBuilder;

/** Streams language-hinted analyzer output without introducing a language detector. */
public final class LuceneProbe {
  private static final String VERSION = "9.12.3";
  private static final Gson JSON = new Gson();
  private static final Map<String, String> ANALYZERS = Map.ofEntries(
      Map.entry("ar", "ar.ArabicAnalyzer"),
      Map.entry("bn", "bn.BengaliAnalyzer"),
      Map.entry("cs", "cz.CzechAnalyzer"),
      Map.entry("da", "da.DanishAnalyzer"),
      Map.entry("de", "de.GermanAnalyzer"),
      Map.entry("el", "el.GreekAnalyzer"),
      Map.entry("en", "en.EnglishAnalyzer"),
      Map.entry("es", "es.SpanishAnalyzer"),
      Map.entry("fa", "fa.PersianAnalyzer"),
      Map.entry("fi", "fi.FinnishAnalyzer"),
      Map.entry("fr", "fr.FrenchAnalyzer"),
      Map.entry("hi", "hi.HindiAnalyzer"),
      Map.entry("hu", "hu.HungarianAnalyzer"),
      Map.entry("hy", "hy.ArmenianAnalyzer"),
      Map.entry("id", "id.IndonesianAnalyzer"),
      Map.entry("it", "it.ItalianAnalyzer"),
      Map.entry("ja", "ja.JapaneseAnalyzer"),
      Map.entry("ko", "ko.KoreanAnalyzer"),
      Map.entry("nb", "no.NorwegianAnalyzer"),
      Map.entry("nl", "nl.DutchAnalyzer"),
      Map.entry("nn", "no.NorwegianAnalyzer"),
      Map.entry("no", "no.NorwegianAnalyzer"),
      Map.entry("pl", "pl.PolishAnalyzer"),
      Map.entry("pt", "pt.PortugueseAnalyzer"),
      Map.entry("ro", "ro.RomanianAnalyzer"),
      Map.entry("ru", "ru.RussianAnalyzer"),
      Map.entry("sv", "sv.SwedishAnalyzer"),
      Map.entry("ta", "ta.TamilAnalyzer"),
      Map.entry("th", "th.ThaiAnalyzer"),
      Map.entry("tr", "tr.TurkishAnalyzer"),
      Map.entry("uk", "uk.UkrainianMorfologikAnalyzer"),
      Map.entry("zh", "cn.smart.SmartChineseAnalyzer"));

  private final Map<String, Analyzer> cache = new HashMap<>();

  private static Analyzer newAnalyzer(String language) throws ReflectiveOperationException {
    String name = ANALYZERS.get(language);
    return name == null
        ? new StandardAnalyzer()
        : (Analyzer) Class.forName("org.apache.lucene.analysis." + name)
            .getConstructor().newInstance();
  }

  private Analyzer analyzer(String language) throws ReflectiveOperationException {
    Analyzer existing = cache.get(language);
    if (existing != null) return existing;
    Analyzer created = newAnalyzer(language);
    cache.put(language, created);
    return created;
  }

  private static String string(JsonObject input, String name, String fallback) {
    if (!input.has(name) || input.get(name).isJsonNull()) return fallback;
    if (!input.get(name).isJsonPrimitive() || !input.get(name).getAsJsonPrimitive().isString()) {
      throw new IllegalArgumentException(name + " must be a string");
    }
    return input.get(name).getAsString();
  }

  private Map<String, Object> analyze(JsonObject input) throws Exception {
    String text = string(input, "text", null);
    if (text == null) throw new IllegalArgumentException("text is required");
    String language = string(input, "language", "und");
    String mode = string(input, "mode", "oracle");
    if (!mode.equals("oracle") && !mode.equals("route")) {
      throw new IllegalArgumentException("mode must be oracle or route");
    }
    String used = mode.equals("route") ? string(input, "routeLanguage", language) : language;
    Analyzer selected = analyzer(used);
    List<Map<String, Object>> tokens = new ArrayList<>();
    try (TokenStream stream = selected.tokenStream("text", text)) {
      CharTermAttribute term = stream.addAttribute(CharTermAttribute.class);
      OffsetAttribute offset = stream.addAttribute(OffsetAttribute.class);
      PositionIncrementAttribute increment = stream.addAttribute(PositionIncrementAttribute.class);
      PositionLengthAttribute length = stream.addAttribute(PositionLengthAttribute.class);
      stream.reset();
      int position = -1;
      while (stream.incrementToken()) {
        position += increment.getPositionIncrement();
        Map<String, Object> token = new LinkedHashMap<>();
        token.put("text", term.toString());
        token.put("start", offset.startOffset());
        token.put("end", offset.endOffset());
        token.put("position", position);
        token.put("positionIncrement", increment.getPositionIncrement());
        token.put("positionLength", length.getPositionLength());
        tokens.add(token);
      }
      stream.end();
    }
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("tokens", tokens);
    result.put("analyzer", selected.getClass().getSimpleName());
    result.put("version", VERSION);
    result.put("language", language);
    result.put("languageUsed", used);
    result.put("mode", mode);
    result.put("fallback", !ANALYZERS.containsKey(used));
    result.put("offsetUnit", "utf16");
    return result;
  }

  private Map<String, Object> retrieve(JsonObject input) throws Exception {
    String rawQuery = string(input, "query", null);
    if (rawQuery == null) throw new IllegalArgumentException("query is required");
    String queryMode = string(input, "queryMode", "grouped");
    if (!queryMode.equals("grouped") && !queryMode.equals("analyzed-or")) {
      throw new IllegalArgumentException("queryMode must be grouped or analyzed-or");
    }
    if (!input.has("documents") || !input.get("documents").isJsonArray()) {
      throw new IllegalArgumentException("documents must be an array");
    }
    Map<String, Analyzer> fieldAnalyzers = new LinkedHashMap<>();
    Set<String> languages = new LinkedHashSet<>();
    List<Document> documents = new ArrayList<>();
    Set<Integer> ids = new LinkedHashSet<>();
    try {
      for (var element : input.getAsJsonArray("documents")) {
        JsonObject row = element.getAsJsonObject();
        if (!row.has("id") || !row.get("id").isJsonPrimitive()
            || !row.getAsJsonPrimitive("id").isNumber()) {
          throw new IllegalArgumentException("document id must be an integer");
        }
        int id = row.get("id").getAsBigDecimal().intValueExact();
        if (!ids.add(id)) throw new IllegalArgumentException("duplicate document id");
        String text = string(row, "text", null);
        if (text == null) throw new IllegalArgumentException("document text is required");
        String language = string(row, "language", "und");
        String field = "text_" + language;
        if (!fieldAnalyzers.containsKey(field)) {
          fieldAnalyzers.put(field, newAnalyzer(language));
        }
        languages.add(language);
        Document document = new Document();
        document.add(new StoredField("id", id));
        document.add(new TextField(field, text, Field.Store.NO));
        documents.add(document);
      }
      if (input.has("queryLanguages")) {
        if (!input.get("queryLanguages").isJsonArray()) {
          throw new IllegalArgumentException("queryLanguages must be an array");
        }
        languages.clear();
        for (var element : input.getAsJsonArray("queryLanguages")) {
          if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("queryLanguages entries must be strings");
          }
          languages.add(element.getAsString());
        }
      }
      for (String language : languages) {
        String field = "text_" + language;
        if (!fieldAnalyzers.containsKey(field)) {
          fieldAnalyzers.put(field, newAnalyzer(language));
        }
      }
      List<Map<String, Object>> results = new ArrayList<>();
      Map<String, String> analyzerNames = new LinkedHashMap<>();
      for (var entry : fieldAnalyzers.entrySet()) {
        analyzerNames.put(entry.getKey(), entry.getValue().getClass().getSimpleName());
      }
      String trimmed = rawQuery.trim();
      boolean phrase = trimmed.length() > 1 && trimmed.startsWith("\"") && trimmed.endsWith("\"");
      List<String> groups = new ArrayList<>();
      if (phrase) {
        groups.add(trimmed.substring(1, trimmed.length() - 1));
      } else {
        for (String group : trimmed.replaceAll("[^\\p{L}\\p{N}\\p{M}_\\s]", " ").split("\\s+")) {
          if (!group.isEmpty() && !Set.of("AND", "OR", "NOT", "NEAR").contains(group.toUpperCase(Locale.ROOT))) {
            groups.add(group);
          }
        }
      }
      String renderedQuery;
      try (Analyzer defaultAnalyzer = new StandardAnalyzer();
          PerFieldAnalyzerWrapper wrapper = new PerFieldAnalyzerWrapper(defaultAnalyzer, fieldAnalyzers);
          ByteBuffersDirectory directory = new ByteBuffersDirectory()) {
        IndexWriterConfig config = new IndexWriterConfig(wrapper);
        config.setSimilarity(new BM25Similarity());
        try (IndexWriter writer = new IndexWriter(directory, config)) {
          for (Document document : documents) writer.addDocument(document);
          writer.commit();
        }
        BooleanQuery.Builder combined = new BooleanQuery.Builder();
        QueryBuilder builder = new QueryBuilder(wrapper);
        builder.setEnableGraphQueries(true);
        builder.setEnablePositionIncrements(true);
        for (String language : languages) {
          for (String group : groups) {
            Query clause = !phrase && queryMode.equals("analyzed-or")
                ? builder.createBooleanQuery("text_" + language, group, BooleanClause.Occur.SHOULD)
                : builder.createPhraseQuery("text_" + language, group);
            if (clause != null) combined.add(clause, BooleanClause.Occur.SHOULD);
          }
        }
        Query query = combined.build();
        renderedQuery = query.toString();
        try (DirectoryReader reader = DirectoryReader.open(directory)) {
          IndexSearcher searcher = new IndexSearcher(reader);
          searcher.setSimilarity(new BM25Similarity());
          int requested = input.has("limit") ? input.get("limit").getAsInt() : documents.size();
          if (requested > 0 && !documents.isEmpty()) {
            for (ScoreDoc hit : searcher.search(query, Math.min(requested, documents.size())).scoreDocs) {
              Document document = searcher.storedFields().document(hit.doc);
              Map<String, Object> result = new LinkedHashMap<>();
              result.put("id", document.getField("id").numericValue().intValue());
              result.put("score", hit.score);
              results.add(result);
            }
          }
        }
      }
      Map<String, Object> output = new LinkedHashMap<>();
      output.put("results", results);
      output.put("version", VERSION);
      output.put("mode", "retrieval");
      output.put("queryMode", queryMode);
      output.put("similarity", "BM25(k1=1.2,b=0.75)");
      output.put("queryLanguages", languages);
      output.put("analyzers", analyzerNames);
      output.put("queryGroups", groups);
      output.put("quotedPhrase", phrase);
      output.put("luceneQuery", renderedQuery);
      output.put("documentCount", documents.size());
      output.put("fallbackLanguages", fieldAnalyzers.keySet().stream()
          .map(field -> field.substring("text_".length()))
          .filter(language -> !ANALYZERS.containsKey(language)).toList());
      return output;
    } finally {
      for (Analyzer analyzer : fieldAnalyzers.values()) analyzer.close();
    }
  }

  public static void main(String[] args) throws Exception {
    LuceneProbe probe = new LuceneProbe();
    try (BufferedReader input = new BufferedReader(
        new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = input.readLine()) != null) {
        if (line.isBlank()) continue;
        try {
          JsonObject request = JsonParser.parseString(line).getAsJsonObject();
          System.out.println(JSON.toJson(request.has("query") ? probe.retrieve(request) : probe.analyze(request)));
        } catch (Exception error) {
          System.out.println(JSON.toJson(Map.of("error", error.toString(), "version", VERSION)));
        }
        System.out.flush();
      }
    } finally {
      for (Analyzer analyzer : probe.cache.values()) analyzer.close();
    }
  }
}
