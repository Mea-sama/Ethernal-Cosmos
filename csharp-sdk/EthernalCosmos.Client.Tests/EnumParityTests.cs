using System.Diagnostics;
using System.Reflection;
using System.Text.RegularExpressions;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

public class EnumParityTests
{
    private static Dictionary<string, HashSet<string>> ParseTs()
    {
        var text = File.ReadAllText(Path.Combine(HubProcess.FindRepoRoot(), "shared", "src", "types", "enums.ts"));
        var result = new Dictionary<string, HashSet<string>>();
        foreach (Match block in Regex.Matches(text, @"export const (\w+) = \{(.*?)\} as const;", RegexOptions.Singleline))
        {
            var values = Regex.Matches(block.Groups[2].Value, @"^\s*\w+:\s*'([^']*)'", RegexOptions.Multiline)
                .Select(m => m.Groups[1].Value).ToHashSet();
            result[block.Groups[1].Value] = values;
        }
        return result;
    }

    private static Dictionary<string, HashSet<string>> CSharpEnums() =>
        typeof(WireValueAttribute).Assembly.GetTypes()
            .Where(t => t.IsEnum && t.Namespace == typeof(WireValueAttribute).Namespace)
            .ToDictionary(t => t.Name, t => t.GetFields(BindingFlags.Public | BindingFlags.Static)
                .Select(f => f.GetCustomAttribute<WireValueAttribute>()?.Value).OfType<string>().ToHashSet());

    [Fact]
    public void Every_wire_value_exists_in_both_languages()
    {
        var ts = ParseTs();
        var cs = CSharpEnums();
        Assert.NotEmpty(ts);
        foreach (var (name, values) in ts)
        {
            Assert.True(cs.ContainsKey(name), $"C# enum {name} missing");
            Assert.Empty(values.Except(cs[name]));
            Assert.Empty(cs[name].Except(values));
        }
        Assert.Empty(cs.Keys.Except(ts.Keys));
    }

    [Fact]
    public void Every_enum_has_an_Unknown_default()
    {
        foreach (var t in typeof(WireValueAttribute).Assembly.GetTypes().Where(t => t.IsEnum && t.Namespace == typeof(WireValueAttribute).Namespace))
            Assert.Equal("Unknown", Enum.GetName(t, Activator.CreateInstance(t)!));
    }

    [Fact]
    public void Generated_file_is_up_to_date()
    {
        var root = HubProcess.FindRepoRoot();
        var psi = new ProcessStartInfo("node", "scripts/gen-csharp-enums.mjs --check")
        {
            WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        Assert.True(p.ExitCode == 0, output);
    }
}
