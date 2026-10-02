---
title: "How I cut 640 personal-AI agent runs from $20 to $6"
description: "Omnesis has a background agent that processes years of emails, messages, calendar events and other personal data. Bootstrapping 3.5 weeks of my own history required 640 agent runs and cost about $20.  Today I got that down to $6—mostly by realizing I'd structured my prompts badly for provider caching."
date: "2026-10-01"
author: "Adrien Conrath"
tags: [Brain, Engineering]
draft: false
---

After a stretch of grinding to get the Context Layer ready for open source, I spent a bit of time improving the efficiency of the Brain. So I’m taking a bit of an opportunity to explain how the Brain works at a high level and the efficiency work I’ve done today.

## What the brain is

The Omnesis Context Layer is what ingests and indexes all your data (emails, messages, calendar, etc). This is a raw and authoritative data layer in the sense that the data is not transformed or derived by any agent. The Omnesis Graph that connects documents and people together (i.e “this Google Doc is mentioned in this WhatsApp conversation that John participates in”) is still considered part of the Context Layer because these connections are undeniable facts rather than synthesized.

The Brain is my work-in-progress take on building a derived data layer on top to better aggregate and structure your personal life. It is an experimental and fun project and I don’t consider myself an academic expert in the field. I will aim to learn as much as possible and be comfortable deleting algorithms as quickly as I add them. What I do know is that having built a Context Layer that indexes data from so many sources makes building the Brain incredibly fun.

In practice, the Brain is a background agent that processes your data and reflects in the background. It is made of multiple types of “runs” orchestrated by a scheduler. The most important types of runs are described below:

- **The “datum” run:** scheduled to run quickly after a new piece of data is ingested and indexed, updated or deleted. Emails are one “datum” while conversations in WhatsApp are debounced by an hour.
- **The “bootstrap” run:** this is similar to the datum run except this backfills on all your past data to bootstrap a model of your world when you enable the Brain. More on that later. This is expensive.
- **The “time-based” run:** A brain run might schedule a re-run at a later date in the future to check something.
- **The “sweep” run:** Sweeps allow arbitrary recipes to run at a configured cadence. There can be recipes to check for health trends, changes in relationships, etc. They can be created/edited by the user.

And seven other run types that I might cover in future blog posts.

## What data structures does the brain maintain?

In each run, the brain investigates by using Omnesis tools to look up people, search and open documents, walk the graph, etc, and then maintains the following data structures:

**Open loops** are things your mind considers unfinished. A task, a decision, an unanswered question or unresolved situation.

The brain is provided with tools to search for loops (vector search + BM25), find existing loops attached to a particular person or document (loops are derived nodes in the Omnesis graph), mutate loops, and resolve loops. A loop contains a description, metadata about people that are actors in the loop, documents that are evidence, metadata about time considerations such as deadlines, and a ledger of timestamped observations that each run can append to.

The main interactive Omnesis agent that responds to you or your external agent can similarly access loops to more efficiently respond to your query but is always asked to reground itself by reading raw source documents.

**The Time Index** is a temporal index that lets Omnesis look up facts and documents by a lookup key which can be a date or time interval. You can query a window such as “27/09/2026” or “next week”, or “October 2027” and the index returns temporal records that match it. This is what allows Omnesis to be efficient at answering “What’s happening in October?”.

There are multiple mechanisms to populate the Time Index. Sometimes source documents will advertise temporal projections (that is the case for calendar events, Strava activities, booking emails which embed structured metadata as schema.org JSON-LD, etc). Omnesis also runs @microsoft/recognizers-text-date-time which is able to extract temporal mentions in documents, for example an email sent on 26/09/2026 that mentions “tomorrow” is considered to mention “27/09/2026”. And finally, the brain is able to make temporal annotations which are interpreted dated facts that it records.

**Annotations** about documents and people. The Brain can annotate people in the graph with durable facts about them: their role, relationships, etc. This includes memory about “self” (the user of Omnesis). It can also annotate durable understanding attached to a particular document: its purpose, important facts, or the status it establishes. Each annotation must cite evidence as (document ID, quote) pairs.

The engine runs two checks:

1. It validates the quote was not hallucinated and actually appears in cited documents.
2. It performs an entailment verification check using a model (I use a MiniCheck-family fact checker) — this is responsible for answering the question “Do the citations entail the conclusion?”

A re-run happens if a cited document changes such that it invalidates a quote. The brain also maintains a main memory / operating notes that it can append to, edit or compact.

## More on the bootstrap

When you connect new sources, you bring years of history with you and the bootstrap lane works through that history so that it does not start from a blank state. This is what allows for example the brain to create an entry in the Time Index for your passport expiration date even though your passport in Google Drive has already been synced and OCR’ed.

Running an agent turn over every email, calendar invite, bank transaction, WhatsApp/iMessage conversation, etc. would be prohibitively expensive. So we do a filtering pass that aims at only considering documents that potentially are still relevant in the future, i.e. that mention a date that has not happened yet. That’s the case for a passport expiring in 2030, a lease renewal next spring, and an Airbnb booking next month. But a receipt from 2019 would typically be filtered out even though it’s still indexed and searchable if the user needs it.

To do this, Omnesis uses a date extractor built on Microsoft’s Recognizers-Text. Each piece of data has a known reference date (the date the email was sent, the date the WhatsApp messages were sent, etc) that can be used for Recognizers-Text to understand that “next week” means “Oct 19-25”, “next year” means “2027” and “on Tuesday” means “Aug 4, 2026”.

One decision I made is to have the bootstrap walk history from the present backwards. I did this for two reasons. The first is an assumption that what happened recently probably matters more to you than what happened years ago and so should be understood first. The bootstrap lane can take many days to complete so might as well prioritize accordingly. The second reason is about not doing work twice. Indeed, when the bootstrap agent works on a recent document (for example an email notification mentioning a change to your train booking), it will anyway end up retrieving and processing the original booking email sent potentially months earlier.

So walking backwards means the context reconstructed for recent documents absorbs much of the older history along the way. So we keep track of which older documents were opened and we mark them as processed such that they are not given their own turn in the bootstrap lane.

![Bootstrap processes the newest documents first, with each run covering older related documents to avoid duplicate work.](/blog/images/brain-prompt-caching/bootstrap-newest-first.png)

## I made recent changes to make the brain more efficient

The bootstrap is fairly expensive. 640 bootstrap runs on my gateway (3.5w of my life) were costing $19-21 so today I started investigating and noticed that I was doing very badly with input prompt caching. Model providers cache the beginning of a prompt and charge much less to re-read it. For example, for DeepSeek V4 flash uncached input is 50x more expensive.

I found a very low hanging fruit opportunity: I noticed that information that changes every run (clock, run details, memory & notes) was present before information that changes infrequently (instructions & rules, tool definitions). So I re-ordered them and input read from cache went from 65% to about 90%.

![Moving stable instructions and tool definitions before changing context increased input served from cache from 65% to about 90%.](/blog/images/brain-prompt-caching/prompt-cache-order.png)

The second thing I wanted to experiment with was using TypeSafe’s Jev, a small decision model, as a cheap filtering gate to determine if a piece of data is worthy of a bootstrap run. So I added a second filtering pass that only applies to emails (where there is the most noise) and feeds Jev the subject, sender and opening of each email to score whether a bootstrap turn is worth it.

Each call takes about 300ms and costs a tiny fraction of a cent. It only filters what is obvious junk (newsletter, marketing, etc). In an experiment that I did, Jev judged 324 bootstrap emails and skipped half of them, for 3c.

![Bootstrap filtering checks future dates, routes recent documents to the live lane, and uses Jev to skip obvious email noise before the agent turn.](/blog/images/brain-prompt-caching/bootstrap-filtering.png)

All in all, re-running the 640 bootstrap runs with the optimizations above decreased the cost to $6. 85% of the impact was from caching and 15% from Jev.

![Bootstrap optimization reduced the cost of 640 runs from $19–21 to $6, and input tokens billed at full price from 130–144 million to 34 million.](/blog/images/brain-prompt-caching/bootstrap-results.png)

Also note that right now the brain does not process web pages that I visited (which are pushed by the Chrome extension) because I assume it’s a lot of noise. I might revisit this in the future.

## What else is on my mind for the brain

The Omnesis Brain is far from perfect. There is so much I would like to invest in:

- Right now I’m implementing it with vibes. I would love to build a proper eval so I can measure the impact of changes/experiments more thoroughly
- The brain still sometimes makes false assumptions even from raw evidence. A friend recently sent me a PDF (with no context) of their analysis of the ROI of their real estate investment, and the brain incorrectly assumed this was my investment. I’m constantly tweaking the prompts but I need to spend more time reading the literature
- I am worried about the problems that come with recursive summarisation / drift and will similarly research that
