<!-- Vendored from mattpocock/skills (MIT © 2026 Matt Pocock), skills/engineering/domain-modeling/CONTEXT-FORMAT.md.
     Pin + adaptations: .claude/skills/PROVENANCE.md · full license: .claude/skills/NOTICE.md -->

# GLOSSARY.md Format

## Structure

```md
# Glossary

{One or two sentences on what this vocabulary is and why it exists.}

## {Cluster name}

**Order** — {a one or two sentence description of the term}
_Avoid_: purchase, transaction

**Invoice** — a request for payment sent to a customer after delivery. The
authoritative description of the mechanism is `docs/billing.md`.
_Avoid_: bill, payment request

**Customer** — a person or organization that places orders.
_Avoid_: client, buyer, account
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- **Point at the authority, don't restate it.** Where a term names a real mechanism, end its entry with the doc or module that describes how the thing works, and stop there. An entry that explains the mechanism is a cache of that doc, and it goes stale silently — taking with it every skill that reads the glossary for vocabulary.
