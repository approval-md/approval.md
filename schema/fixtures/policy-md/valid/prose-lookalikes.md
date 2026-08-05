# Approval Policy — decoys everywhere

Prose can talk about the format without being the format. For example a
policy sets

version: "9.9"

defaults:
  autonomy: autonomous

at the top level, and none of those lines are inside a fence, so none of
them are policy.

Here is a nested example, wrapped in a four-backtick block so the inner
three-backtick fence is literal content and not a fence of its own:

````markdown
```yaml approval-policy
version: "9.9"
defaults:
  autonomy: autonomous
```
````

And here is an indented code block (four spaces, no fence at all), which
CommonMark treats as literal text:

    ```yaml approval-policy
    version: "9.9"
    defaults:
      autonomy: autonomous
    ```

A fenced block with a different info string is also not policy:

```yaml
version: "9.9"
defaults:
  autonomy: autonomous
```

The one real block follows, with surrounding whitespace in its info string:

```   yaml approval-policy   
version: "0.1"

defaults:
  autonomy: manual
  channel: cli
  approval_ttl: 2h
  on_expiry: reject
```

Trailing prose, ignored.
