namespace EthernalCosmos.Client.Tests;

/// <summary>Helpers to await client events with a timeout. Subscribe BEFORE triggering the action.</summary>
public static class Wait
{
    public static readonly TimeSpan Default = TimeSpan.FromSeconds(8);

    /// <summary>Starts listening immediately; await the returned task to get the first event matching <paramref name="predicate"/>.</summary>
    public static Task<T> For<T>(Action<Action<T>> subscribe, Action<Action<T>> unsubscribe, Func<T, bool>? predicate = null, TimeSpan? timeout = null)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action<T>? handler = null;
        handler = v =>
        {
            if (predicate is null || predicate(v))
            {
                unsubscribe(handler!);
                tcs.TrySetResult(v);
            }
        };
        subscribe(handler);
        return WithTimeout(tcs.Task, timeout ?? Default, () => unsubscribe(handler));
    }

    /// <summary>Waits for a no-argument event.</summary>
    public static Task ForSignal(Action<Action> subscribe, Action<Action> unsubscribe, TimeSpan? timeout = null)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Action? handler = null;
        handler = () => { unsubscribe(handler!); tcs.TrySetResult(); };
        subscribe(handler);
        return WithTimeout(tcs.Task, timeout ?? Default, () => unsubscribe(handler));
    }

    /// <summary>Polls a condition until true.</summary>
    public static async Task Until(Func<bool> condition, string what, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? Default);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Timed out waiting for: {what}");
            await Task.Delay(50);
        }
    }

    public static async Task<T> UntilResult<T>(Func<Task<T>> fetch, Func<T, bool> done, string what, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? Default);
        while (true)
        {
            var v = await fetch();
            if (done(v)) return v;
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Timed out waiting for: {what}");
            await Task.Delay(100);
        }
    }

    private static async Task<T> WithTimeout<T>(Task<T> task, TimeSpan timeout, Action cleanup)
    {
        var done = await Task.WhenAny(task, Task.Delay(timeout));
        if (done != task)
        {
            cleanup();
            throw new TimeoutException($"Timed out after {timeout.TotalSeconds:0.#}s waiting for {typeof(T).Name} event");
        }
        return await task;
    }

    private static async Task WithTimeout(Task task, TimeSpan timeout, Action cleanup)
    {
        var done = await Task.WhenAny(task, Task.Delay(timeout));
        if (done != task)
        {
            cleanup();
            throw new TimeoutException($"Timed out after {timeout.TotalSeconds:0.#}s waiting for signal event");
        }
        await task;
    }
}
