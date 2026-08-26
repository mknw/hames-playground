# Welcome to the preview

You have been given access to an internal assistant we are building. It is a
**preview**, not a product: a small group is using it so we find out what is
useful and what is broken before anyone depends on it.

Please read the "What happens to what you type" section before your first
message. It is short, and it is the part that should change how you use this.

---

## Signing in

Go to the address you were sent and click **Sign in with Microsoft**. Use your
normal `@dtsc.be` work account — there is no separate password.

Access is restricted twice over: the sign-in only accepts accounts in the DTSC
tenant, and on top of that only addresses on an explicit list get a session.
If you land on a page saying access is denied, you are signed in to Microsoft
correctly but your address is not on the list yet — say so and it can be added.

Signing out is in the user menu. It ends the session properly rather than just
closing the tab.

## What it does

You chat with it, and it can use tools on your behalf while it answers:

- search and read your **Outlook mail, calendar, and SharePoint / OneDrive
  files** — as you, with your permissions, so in Microsoft 365 it can never
  reach anything you could not open yourself;
- search the **web**;
- read and write a **knowledge graph**, and draw it for you — one shared graph,
  the same one for everybody in the preview, so anything it writes there is
  visible to a colleague's next question and anything they write is visible to
  yours;
- **upload documents** and ask questions about them;
- **run code** in a throwaway container for calculations, data wrangling and
  file conversion.

It will sometimes be confidently wrong. Check anything you intend to act on.

## What happens to what you type

We would rather over-explain this than have you assume something convenient.

**Your messages are sent to Anthropic**, the company behind the Claude models,
which processes them to generate the answers. That is the only external model
provider involved — nothing is sent anywhere else for inference. Anything the
assistant reads on your behalf goes with it: if it searches your mailbox to
answer, the content of the messages it found is part of what gets sent.

**Nothing is anonymised on the way out.** Names, addresses and identifying
details in your conversation — yours or anyone else's — go as written. We have
built the machinery to substitute them and it is not switched on yet, so please
do not rely on it being there.

**Conversations are stored, in full, on our own server** — a virtual machine we
control, in our own subscription, along with any documents you upload and any
graph content that gets created. The full exchange is kept, including whatever
the tools retrieved for you, so a conversation that searched your mailbox
contains a copy of those messages.

That stored copy is **encrypted by the application**, on top of the server's own
disk encryption: the text of your conversations, and the name and address we
hold for you, sit in the database scrambled rather than readable. Be clear about
what that covers — the key lives on the same server, so it protects a disk or a
copy of the database that leaves the machine, not someone who can use the
machine itself. Access to the server is limited to the small group running the
preview.

**There is no delete button yet**, and no automatic expiry on conversations.
Uploaded documents are removed after seven days; conversations are not removed
at all. If you want something erased, ask — it can be done by hand.

**Nothing is copied off that server.** There is no second copy of your
conversations or your uploads anywhere — no cloud backup, no archive. That
protects your privacy and it means the other thing too: if the machine is lost
or reset, everything in it goes with it, and none of it comes back. Keep
anything you would miss somewhere of your own.

### What that means in practice

Use it for your ordinary work. Do not use it for:

- anything about a **colleague or client that you would not put in an email**
  they might one day read;
- **special-category personal data** — health, union membership, and the rest of
  that list;
- **credentials** of any kind — passwords, API keys, tokens;
- material a client contract says stays in-house.

If you are unsure, that hesitation is the answer: ask first.

## Reporting problems

Everything is worth reporting — a wrong answer, a slow one, a confusing screen,
a spelling mistake. There is no triage overhead to spare you from.

**Open a GitHub issue on `mknw/hames-playground` with the `preview` label.**

> ⚠️ **That repository is public.** Anything you put in an issue — the text, a
> screenshot, an error message — is readable by anyone on the internet, and
> stays readable in the history even if the issue is edited or deleted later.
> Given what the previous section says about what this assistant reads on your
> behalf, assume a screenshot of a conversation contains mail content, names or
> file contents that should not go there.

So: **describe the problem, do not paste the conversation.** Useful things to
include, none of them mandatory:

- what you asked and what you expected instead, in your own words;
- roughly when it happened (the server keeps logs by time);
- which agent you had selected;
- a screenshot **only if you have checked what is in it**.

Anything you would rather not make public — the actual text of a conversation,
a screenshot you are unsure about, anything involving a client or a colleague —
send directly to Michael instead. That is the normal route, not the exception.

**If something looks like a security or privacy problem** — you can see someone
else's conversation, the assistant returns data you should not have access to,
an address outside `@dtsc.be` gets in — do not open a public issue. Say so
directly and immediately.

## What to expect

It will break sometimes. It is one server with no redundancy, so if it is
restarted mid-answer, that answer is lost — reload and ask again. **Treat
everything in it as temporary**: nothing is copied off that machine, so losing
it loses the contents with it, and the preview may be wiped and rebuilt at any
point anyway. Expect short interruptions with no notice, and expect it to be
reset or reshaped based on what you tell us.

Thank you for trying it.
