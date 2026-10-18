# StatePharma Quick View (iPhone web app)

Quick View for iPhone, iPad and any phone browser. It looks and works like the Android app:
Today, Stock, Products, Orders and Data.

**No data is in this folder or on the website.** The site only gives the phone the app itself.
Each person loads the **Quick View data.spqv** file from the SharePoint *Quick View* folder; the file is
read and kept on that phone only. The page's security rule (in `index.html`) stops it from sending
anything over the internet.

## 1. Put it on GitHub Pages (one time, about 5 minutes)

1. On github.com, click **New repository**. Name it, for example, `quickview`.
   - Free plan: choose **Public** (only this app's code is in it; no data).
   - GitHub Pro: you can choose **Private**.
2. On the new repository page click **uploading an existing file**, drag in **everything in this folder**
   (index.html, app.js, app.css, sw.js, manifest.webmanifest, the icons folder, .nojekyll, README.md) and click **Commit changes**.
3. Open **Settings › Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, **Save**.
4. After a minute the page shows the link, for example `https://<your-name>.github.io/quickview/`.

## 2. On each iPhone (one time)

1. Install **OneDrive** from the App Store and sign in with the @statepharma.mv account.
2. Open the link in **Safari** › **Share** › **Add to Home Screen**.
3. Open **Quick View** from the Home Screen › **Load the data file** › **Browse** › **OneDrive** ›
   the APP folder › **Quick View** › tap **Quick View data.spqv**.

Tip: in SharePoint on the office PC, open the APP folder and choose **Add shortcut to My files**;
it then shows under OneDrive › My files on every phone.

## 3. Updating

- **Data:** the Planning App makes a new data file after every run (the automatic runs too) and puts it in
  the SharePoint Quick View folder. On the phone: Today › refresh button (or Data › Load the data file).
- **The app:** upload the new files over the old ones in the repository (Add file › Upload files › Commit).
  Within a minute or two every phone shows *"A new version of Quick View is ready – Reload"*. Data on the
  phones is kept.

## Files

| File | What it is |
|---|---|
| index.html | The page and its security rule |
| app.js | The app (same rules as the Android app) |
| app.css | Look and feel (follows the phone's light/dark setting) |
| sw.js | Lets it open offline; a changed version number here = a new app version |
| manifest.webmanifest, icons/ | Home Screen name and icon |
