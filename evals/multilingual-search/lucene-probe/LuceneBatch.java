// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.standard.StandardAnalyzer;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.NumericDocValuesField;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.BoostQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.Sort;
import org.apache.lucene.search.SortField;
import org.apache.lucene.search.similarities.BM25Similarity;
import org.apache.lucene.store.FSDirectory;
import org.apache.lucene.util.QueryBuilder;

/** One durable reference index per language/size, with actual analyzer graphs. */
public final class LuceneBatch {
  private static final Gson JSON = new Gson();
  private static final String SEED = "omnesis-lexical-heldout-v1-2026-11-13";
  private static final Map<String, String> ANALYZERS = Map.ofEntries(
      Map.entry("ar", "ar.ArabicAnalyzer"), Map.entry("bn", "bn.BengaliAnalyzer"),
      Map.entry("de", "de.GermanAnalyzer"), Map.entry("en", "en.EnglishAnalyzer"),
      Map.entry("es", "es.SpanishAnalyzer"), Map.entry("fa", "fa.PersianAnalyzer"),
      Map.entry("fi", "fi.FinnishAnalyzer"), Map.entry("fr", "fr.FrenchAnalyzer"),
      Map.entry("hi", "hi.HindiAnalyzer"), Map.entry("id", "id.IndonesianAnalyzer"),
      Map.entry("ja", "ja.JapaneseAnalyzer"), Map.entry("ko", "ko.KoreanAnalyzer"),
      Map.entry("ru", "ru.RussianAnalyzer"), Map.entry("te", "te.TeluguAnalyzer"),
      Map.entry("th", "th.ThaiAnalyzer"), Map.entry("zh", "cn.smart.SmartChineseAnalyzer"));

  private static Analyzer analyzer(String language) throws ReflectiveOperationException {
    String name = ANALYZERS.get(language);
    return name == null ? new StandardAnalyzer()
        : (Analyzer) Class.forName("org.apache.lucene.analysis." + name).getConstructor().newInstance();
  }

  private static String order(String language, String id) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256")
        .digest((SEED + "|" + language + "|" + id).getBytes(StandardCharsets.UTF_8));
    return HexFormat.of().formatHex(digest);
  }

  private static Query fieldQuery(QueryBuilder builder, String field, String text, boolean phrase) {
    return phrase ? builder.createPhraseQuery(field, text) : builder.createBooleanQuery(field, text, BooleanClause.Occur.SHOULD);
  }

  private static void exportStopwords(Path output) throws Exception {
    Map<String, Object> languages = new LinkedHashMap<>();
    for (String language : List.of("ar", "bn", "de", "en", "es", "fa", "fi", "fr", "hi", "id", "ja", "ko", "ru", "sw", "te", "th", "zh")) {
      Map<String, Object> entry = new LinkedHashMap<>();
      List<String> words = new ArrayList<>();
      try (Analyzer selected = analyzer(language)) {
        entry.put("analyzer", selected.getClass().getSimpleName());
        try {
          var method = selected.getClass().getMethod("getDefaultStopSet");
          Object stopwords = method.invoke(Modifier.isStatic(method.getModifiers()) ? null : selected);
          if (stopwords instanceof Iterable<?> iterable) {
            for (Object value : iterable) words.add(value instanceof char[] chars ? new String(chars) : value.toString());
          }
          else throw new IllegalStateException("Unexpected default stopword collection type");
          words.sort(Comparator.naturalOrder());
          entry.put("status", words.isEmpty() ? "empty" : "available");
        } catch (NoSuchMethodException absent) {
          entry.put("status", "unsupported");
        }
      }
      entry.put("words", words); languages.put(language, entry);
    }
    Files.writeString(output, JSON.toJson(Map.of("version", "9.12.3", "languages", languages)), StandardCharsets.UTF_8);
  }

  public static void main(String[] args) throws Exception {
    if (args.length == 2 && args[0].equals("--stopwords")) { exportStopwords(Path.of(args[1])); return; }
    if (args.length != 6) throw new IllegalArgumentException("Usage: LuceneBatch LANGUAGE DOCUMENTS QUERIES COUNT INDEX_DIRECTORY OUTPUT");
    String language = args[0];
    if (!language.matches("[a-z]{2,3}")) throw new IllegalArgumentException("Invalid language");
    Path documentsPath = Path.of(args[1]), queriesPath = Path.of(args[2]), indexPath = Path.of(args[4]);
    int count = Integer.parseInt(args[3]);
    if (count < 1 || count > 1000000) throw new IllegalArgumentException("Invalid count");
    Map<String, String> hashOrder = new HashMap<>();
    try (BufferedReader input = Files.newBufferedReader(documentsPath, StandardCharsets.UTF_8)) {
      for (int i = 0; i < count; i++) {
        String line = input.readLine();
        if (line == null) throw new IllegalArgumentException("Corpus shorter than requested count");
        JsonObject row = JsonParser.parseString(line).getAsJsonObject();
        String id = row.get("id").getAsString();
        if (hashOrder.put(id, order(language, id)) != null) throw new IllegalArgumentException("Duplicate document ID");
      }
    }
    List<String> ordered = new ArrayList<>(hashOrder.keySet());
    ordered.sort(Comparator.comparing(hashOrder::get));
    Map<String, Integer> ordinal = new HashMap<>();
    for (int i = 0; i < ordered.size(); i++) ordinal.put(ordered.get(i), i);
    Map<String, Object> report = new LinkedHashMap<>();
    report.put("language", language); report.put("version", "9.12.3"); report.put("count", count);
    report.put("jvm", System.getProperty("java.version"));
    report.put("querySemantics", "Analyzer QueryBuilder SHOULD across body + title boost2; quoted input is a phrase; built-in stopwords and graphs retained.");
    report.put("qualification", "Lucene uses per-field statistics and compressed norms; title boost2 multiplies a field score instead of SQLite column-weighted TF; repeated terms follow QueryBuilder semantics. Not raw-score parity with SQLite.");
    long started = System.nanoTime();
    try (Analyzer selected = analyzer(language); FSDirectory directory = FSDirectory.open(indexPath)) {
      report.put("analyzer", selected.getClass().getSimpleName());
      IndexWriterConfig configuration = new IndexWriterConfig(selected);
      configuration.setOpenMode(IndexWriterConfig.OpenMode.CREATE);
      configuration.setSimilarity(new BM25Similarity(1.2f, .75f));
      configuration.setRAMBufferSizeMB(64);
      try (IndexWriter writer = new IndexWriter(directory, configuration);
          BufferedReader input = Files.newBufferedReader(documentsPath, StandardCharsets.UTF_8)) {
        for (int i = 0; i < count; i++) {
          JsonObject row = JsonParser.parseString(input.readLine()).getAsJsonObject();
          String id = row.get("id").getAsString();
          Document document = new Document();
          document.add(new StoredField("id", id));
          document.add(new NumericDocValuesField("order", ordinal.get(id)));
          document.add(new TextField("body", row.get("text").getAsString(), Field.Store.NO));
          document.add(new TextField("title", row.get("title").getAsString(), Field.Store.NO));
          writer.addDocument(document);
        }
        writer.commit();
      }
      report.put("indexSeconds", (System.nanoTime() - started) / 1e9);
      long bytes = 0;
      for (String file : directory.listAll()) bytes += directory.fileLength(file);
      report.put("indexBytes", bytes);
      List<Map<String, Object>> rows = new ArrayList<>();
      started = System.nanoTime();
      try (DirectoryReader reader = DirectoryReader.open(directory);
          BufferedReader input = Files.newBufferedReader(queriesPath, StandardCharsets.UTF_8)) {
        IndexSearcher searcher = new IndexSearcher(reader);
        searcher.setSimilarity(new BM25Similarity(1.2f, .75f));
        QueryBuilder builder = new QueryBuilder(selected);
        Sort sort = new Sort(SortField.FIELD_SCORE, new SortField("order", SortField.Type.LONG));
        for (String line; (line = input.readLine()) != null;) {
          JsonObject record = JsonParser.parseString(line).getAsJsonObject();
          String text = record.get("text").getAsString().trim();
          boolean phrase = text.length() > 1 && text.startsWith("\"") && text.endsWith("\"");
          if (phrase) text = text.substring(1, text.length() - 1);
          Query body = fieldQuery(builder, "body", text, phrase), title = fieldQuery(builder, "title", text, phrase);
          BooleanQuery.Builder combined = new BooleanQuery.Builder();
          if (body != null) combined.add(body, BooleanClause.Occur.SHOULD);
          if (title != null) combined.add(new BoostQuery(title, 2), BooleanClause.Occur.SHOULD);
          List<String> ranking = new ArrayList<>(); double topScore = 0;
          for (ScoreDoc hit : searcher.search(combined.build(), 100, sort, true).scoreDocs) {
            if (ranking.isEmpty()) topScore = hit.score;
            ranking.add(searcher.storedFields().document(hit.doc).get("id"));
          }
          Map<String, Object> result = new LinkedHashMap<>();
          result.put("id", record.get("id").getAsString()); result.put("split", record.get("split").getAsString());
          result.put("subset", record.get("subset").getAsString()); result.put("ranking", ranking); result.put("topScore", topScore);
          rows.add(result);
        }
      }
      report.put("querySeconds", (System.nanoTime() - started) / 1e9); report.put("rows", rows);
    }
    Files.writeString(Path.of(args[5]), JSON.toJson(report), StandardCharsets.UTF_8);
    System.out.println(JSON.toJson(Map.of("language", language, "count", count, "status", "passed")));
  }
}
