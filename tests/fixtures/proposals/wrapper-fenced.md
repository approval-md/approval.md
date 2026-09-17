# A pair whose blocks contain fences of their own

The four-backtick wrapper belongs to this page. What is replaced is the whole
fenced block below it, from its opening fence through its closing one, which is
the shape APRV-273's incident had: a paste took the wrapper with it, and the
block the loader wanted was never seen.

Current:

````yaml
```yaml approval-values
version: 1
love:
  - honest thoughts
```
````

Replace with:

````yaml
```yaml approval-values
version: "0.2"
love:
  - honest thoughts
```
````
