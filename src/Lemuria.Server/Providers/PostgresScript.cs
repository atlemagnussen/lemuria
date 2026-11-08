namespace Lemuria.Server.Providers;

/// <summary>
/// Splits a Postgres script into statements on top-level semicolons, the way psql does: semicolons inside
/// '…', E'…', "…", $tag$…$tag$, -- and (nested) /* */ comments, and SQL-standard routine bodies
/// (CREATE FUNCTION … BEGIN ATOMIC … END) don't count. Statements that are only comments are dropped.
/// </summary>
public static class PostgresScript
{
    public static IReadOnlyList<SqlBatch> Split(string sql)
    {
        var batches = new List<SqlBatch>();
        var line = 1;
        var start = -1;            // index of the statement's first non-whitespace char
        var startLine = 1;
        var hasCode = false;       // anything besides comments/whitespace?
        var words = new List<string>(4);  // first words, to recognise CREATE [OR REPLACE] FUNCTION/PROCEDURE
        var routine = false;
        var depth = 0;             // BEGIN/CASE … END nesting inside a routine body

        void Begin(int i)
        {
            if (start >= 0) return;
            start = i;
            startLine = line;
        }

        void Emit(int end)
        {
            if (start >= 0 && hasCode) batches.Add(new SqlBatch(sql[start..end], startLine));
            start = -1;
            hasCode = false;
            words.Clear();
            routine = false;
            depth = 0;
        }

        // Advance i past [from, to), counting newlines.
        int Skip(int from, int to)
        {
            for (var k = from; k < to && k < sql.Length; k++) if (sql[k] == '\n') line++;
            return Math.Min(to, sql.Length);
        }

        var i = 0;
        while (i < sql.Length)
        {
            var ch = sql[i];
            var next = i + 1 < sql.Length ? sql[i + 1] : '\0';

            if (ch == '\n') { line++; i++; continue; }
            if (char.IsWhiteSpace(ch)) { i++; continue; }

            if (ch == '-' && next == '-')
            {
                Begin(i);
                var eol = sql.IndexOf('\n', i);
                i = eol < 0 ? sql.Length : eol;
                continue;
            }

            if (ch == '/' && next == '*')
            {
                Begin(i);
                i = Skip(i, BlockCommentEnd(sql, i));
                continue;
            }

            if (ch == ';' && depth == 0)
            {
                Emit(i);
                i++;
                continue;
            }

            Begin(i);
            hasCode = true;

            if (ch == '\'')
            {
                var escapes = i > 0 && sql[i - 1] is 'E' or 'e' && (i < 2 || !IsIdentChar(sql[i - 2]));
                i = Skip(i, QuotedEnd(sql, i, '\'', escapes));
            }
            else if (ch == '"')
            {
                i = Skip(i, QuotedEnd(sql, i, '"', backslashEscapes: false));
            }
            else if (ch == '$' && (i == 0 || !IsIdentChar(sql[i - 1])) && DollarTag(sql, i) is { } tag)
            {
                var close = sql.IndexOf(tag, i + tag.Length, StringComparison.Ordinal);
                i = Skip(i, close < 0 ? sql.Length : close + tag.Length);
            }
            else if (IsIdentStart(ch))
            {
                var end = i;
                while (end < sql.Length && IsIdentChar(sql[end])) end++;
                OnWord(sql[i..end]);
                i = end;
            }
            else
            {
                i++;
            }
        }
        Emit(sql.Length);
        return batches;

        void OnWord(string word)
        {
            if (words.Count < 4)
            {
                words.Add(word.ToUpperInvariant());
                routine = words is ["CREATE", "FUNCTION" or "PROCEDURE", ..] or ["CREATE", "OR", "REPLACE", "FUNCTION" or "PROCEDURE"];
            }
            if (!routine) return;
            if (word.Equals("BEGIN", StringComparison.OrdinalIgnoreCase) || word.Equals("CASE", StringComparison.OrdinalIgnoreCase)) depth++;
            else if (word.Equals("END", StringComparison.OrdinalIgnoreCase) && depth > 0) depth--;
        }
    }

    private static bool IsIdentStart(char c) => char.IsLetter(c) || c == '_' || c > 127;

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c is '_' or '$' || c > 127;

    /// <summary>Index just past the closing quote ('' or "" escape the quote; E'' strings also use backslash).</summary>
    private static int QuotedEnd(string sql, int open, char quote, bool backslashEscapes)
    {
        for (var k = open + 1; k < sql.Length; k++)
        {
            if (backslashEscapes && sql[k] == '\\') { k++; continue; }
            if (sql[k] != quote) continue;
            if (k + 1 < sql.Length && sql[k + 1] == quote) { k++; continue; }
            return k + 1;
        }
        return sql.Length;
    }

    /// <summary>Index just past the end of a (nested) block comment starting at <paramref name="open"/>.</summary>
    private static int BlockCommentEnd(string sql, int open)
    {
        var level = 0;
        for (var k = open; k < sql.Length - 1; k++)
        {
            if (sql[k] == '/' && sql[k + 1] == '*') { level++; k++; }
            else if (sql[k] == '*' && sql[k + 1] == '/' && --level == 0) return k + 2;
            else if (sql[k] == '*' && sql[k + 1] == '/') k++;
        }
        return sql.Length;
    }

    /// <summary>The $tag$ opening at <paramref name="i"/>, or null for things like the $1 parameter.</summary>
    private static string? DollarTag(string sql, int i)
    {
        var k = i + 1;
        if (k < sql.Length && char.IsDigit(sql[k])) return null;
        while (k < sql.Length && sql[k] != '$')
        {
            if (!(char.IsLetterOrDigit(sql[k]) || sql[k] == '_' || sql[k] > 127)) return null;
            k++;
        }
        return k < sql.Length ? sql[i..(k + 1)] : null;
    }
}
