# I Built a Cloud App with AWS Blocks — A Beginner's Story

## First, what is AWS Blocks?

If you've ever tried to build an app on AWS, you know it can feel overwhelming. You need a database, file storage, login, email, and more — and setting up each one by hand takes a lot of time.

**AWS Blocks** makes this much easier. It's an open-source toolkit from AWS for building the backend of full-stack apps. The idea is simple:

- Each feature you need is a **"Block."**
- A Block is just one line of code you add to your app.
- Each Block already knows how to set up its own AWS service for you, following AWS best practices.

So instead of manually creating a database, you just use the `DistributedTable` Block. Instead of setting up email servers, you use the `EmailClient` Block. You pick the Blocks you need, combine them, and AWS Blocks builds the cloud setup automatically.

**The two things that make it special:**

1. **It runs on your laptop first.** You don't even need an AWS account to start. Every Block has a local version, so you can build and test for free, offline.
2. **The same code goes to the cloud.** When you're ready, you deploy — and the exact same code now runs on real AWS services. You change nothing.

Here are some of the Blocks you can use:

| Block | What it gives you | AWS service |
|---|---|---|
| `AuthBasic` / `AuthCognito` | User login | DynamoDB / Cognito |
| `FileBucket` | File storage | S3 |
| `DistributedTable` | Database | DynamoDB |
| `AsyncJob` | Background tasks | SQS + Lambda |
| `CronJob` | Scheduled tasks | EventBridge |
| `Realtime` | Live updates | API Gateway WebSocket |
| `EmailClient` | Sending email | SES |

There are more too — for AI agents, SQL databases, logging, and so on. You only use what you need.

**How it works behind the scenes:** the same line of code, like `new FileBucket(scope, 'media')`, becomes a local folder on your laptop during development, and a real S3 bucket when you deploy. You never rewrite anything.

Okay — now that you know what Blocks is, here's what I built with it.

## What I built

A simple **image upload app**. Here's what it does:

1. You sign in.
2. You upload an image.
3. The app saves it and processes it in the background.
4. You see live progress on the screen.
5. You get an email when it's done.
6. Every night, it emails you a summary of your activity.

This is called an **event-driven pipeline** — things happen automatically in steps, one after another.

## Which Blocks I used

For this one small app, I combined several Blocks:

| What I needed | Block | AWS service |
|---|---|---|
| Login | `AuthBasic` | Cognito-style auth |
| File storage | `FileBucket` | S3 |
| Database | `DistributedTable` | DynamoDB |
| Background jobs | `AsyncJob` | SQS + Lambda |
| Live updates | `Realtime` | AppSync |
| Email | `EmailClient` | SES |
| Nightly schedule | `CronJob` | EventBridge |

Each one was just a few lines of code. I never touched the AWS console to set them up.

## Building it was fast

Because each service is just one line, I spent my time on the actual app logic instead of cloud setup. I ran it locally with one command and watched the whole pipeline work — upload, background processing, live progress, and email — all on my own machine, for free.

## Deploying to real AWS

When I was ready, I ran one deploy command. Blocks created everything on AWS for me: the website, the backend, the database, storage, the queue, email, and the nightly schedule. The exact same code that ran on my laptop now runs in the cloud.

My app is now live on a real web address, with a working backend, and it sends real emails.

## Would I recommend AWS Blocks?

Yes, especially for beginners, prototypes, and small apps. The best parts:

- Write once, run on laptop and cloud.
- Very fast to build.
- No manual AWS setup.

The main promise — *one codebase, laptop to cloud* — really held up. If you want to build a backend on AWS without becoming an infrastructure expert, it's worth a try.

*Code: [github.com/DeepikaSidda/media-workflows-aws-blocks](https://github.com/DeepikaSidda/media-workflows-aws-blocks)*
