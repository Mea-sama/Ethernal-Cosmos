using System.Reflection;
using Xunit;

namespace EthernalCosmos.Client.Tests;

// Guards against shipping a public API member that is neither tested nor documented.
public class ApiCoverageTests
{
    private static string TestsDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "EthernalCosmos.Client.Tests.csproj"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("tests dir not found");
    }

    private static IEnumerable<string> Members()
    {
        var t = typeof(EthernalClient);
        foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Where(m => !m.IsSpecialName))
            yield return m.Name;
        foreach (var e in t.GetEvents(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)) yield return e.Name;
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)) yield return p.Name;
    }

    [Fact]
    public void Every_public_member_is_used_in_tests()
    {
        var self = nameof(ApiCoverageTests) + ".cs";
        var source = string.Join("\n", Directory.GetFiles(TestsDir(), "*.cs").Where(f => Path.GetFileName(f) != self)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .Select(File.ReadAllText));
        var missing = Members().Distinct().Where(n => !System.Text.RegularExpressions.Regex.IsMatch(source, $@"\b{n}\b")).ToList();
        Assert.True(missing.Count == 0, "Not exercised by tests: " + string.Join(", ", missing));
    }

    [Fact]
    public void Every_public_member_is_documented()
    {
        var root = new DirectoryInfo(TestsDir());
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "docs", "sdk-csharp.md"))) root = root.Parent;
        var doc = File.ReadAllText(Path.Combine(root!.FullName, "docs", "sdk-csharp.md"));
        var missing = Members().Distinct().Where(n => !System.Text.RegularExpressions.Regex.IsMatch(doc, $@"\b{n}\b")).ToList();
        Assert.True(missing.Count == 0, "Not in docs/sdk-csharp.md: " + string.Join(", ", missing));
    }
}
