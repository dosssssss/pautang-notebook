# Pautang Notebook

A phone-friendly utang (credit) ledger for a sari-sari store.

- Add customers and record **utang** as item lines (product, qty, price) that total automatically.
- Record **bayad** payments, full or partial hulog.
- See the total **frozen money** (all unpaid utang) at the top, plus each customer's running balance.
- Installable: open the site on your phone and choose **Add to Home screen**. It works offline after the first visit.

## Where the data lives

Everything is saved in the phone's browser storage (`localStorage`). Nothing is sent to a server, and nothing is stored in this repo. Clearing the browser's site data erases the records, so don't clear data for this site.

## Running it

It is a single static page with no build step. Open `index.html` in a browser, or serve the folder with any static server:

```sh
python3 -m http.server 8000
```

It is deployed with GitHub Pages from the `main` branch.

When you change any app file, bump `CACHE` in `sw.js` so installed copies update.
