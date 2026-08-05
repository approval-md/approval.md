# Approval Policy

A billion-laughs document: nested anchors whose aliases expand
multiplicatively. The loader caps alias expansion (MAX_ALIAS_COUNT), so
this fails closed as `yaml-error` instead of exhausting memory.

```yaml approval-policy
version: "0.1"
a: &a ["lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol", "lol"]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]
e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]
f: [*e, *e, *e, *e, *e, *e, *e, *e, *e]
```
