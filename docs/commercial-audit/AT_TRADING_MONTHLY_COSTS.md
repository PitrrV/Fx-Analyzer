# AT Trading FX Analyzer – Měsíční provozní náklady (Fáze 5)

*Kurz: 1 USD = 21,78 Kč (ČNB, lístek na 26. 10. 2026 – nejnovější, který se podařilo najít; zdroj https://zpravy.kurzy.cz/879480-kurzovni-listek-cnb-na-pondeli-26-10-2026/). Aktuální listopadový kurz nepotvrzen.*
*Všechny částky USD/měsíc bez DPH. Přepočet zaokrouhlen.*

## Ověřené ceny (z webu, sekundární zdroje, zkontrolovat na oficiálních ceníkách)
| Položka | Cena | Zdroj |
|---|---|---|
| Supabase Pro | $25/měs. na organizaci; 100 000 MAU, 8 GB disk, 250 GB bandwidth, 100 GB storage; extra disk $0,125/GB; další projekt $10 | https://supabase.com/pricing (úryvek) a blogy 2026, např. https://schematichq.com/blog/supabase-pricing |
| Resend | Free 3 000 e-mailů (max 100/den); Pro $20 za 50 000; přes limit ~$0,90/1000 (zdroje se liší u vyšších tarifů) | https://resend.com/pricing.md |
| Stripe ČR | ~1,5 % + 6,50 Kč EU karty; 3,25 % + 6,50 Kč mimo EU (třetí strana, **nepotvrzeno oficiálně**); DPH/OSS neřeší | https://stripe.com/de-cz/pricing |
| Paddle / Lemon Squeezy (merchant of record) | 5 % + $0,50 za transakci, řeší DPH po celém světě | https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/ (sekundární) |
| Finnhub forex | $49,99 / $129,99 – licence „personal use“ | https://www.finnhub.io/pricing-forex-api |
| Tiingo display redistribution | ~$250 (startup) / $500 – nepotvrzeno | https://api.tiingo.com/products/forex-api |
| LLM (cache modelů 2026-11-03) | Sonnet 5.5 $2 / $10 za 1M tokenů (vstup/výstup), Haiku 5.5 $0,10 / $0,50 | skill `claude-api` |

## Neověřené (odhady z mé znalosti – **NEOVĚŘENO**, dopsat po kontrole ceníků)
Cloudflare Pages/Netlify/Vercel hosting (free až ~$20), Supabase compute add-on (~$15–60), Sentry/Better Stack monitoring (~$26–55), PITR/zálohy (~$100), GitHub Actions v privátním repu ($4 Team + minuty), doména (~$1,5), datové licence (placeholder $750, rozpětí $500–1 500 – **čistý odhad, ne ceník**).

## Předpoklady
- Cena předplatného **$15/měs.** (~327 Kč); platební poplatky ~$0,60/zákazníka (Stripe blended); u merchant of record by to bylo ~$1,25 + DPH vyřešená.
- 1 projekt Supabase (DB dnes 85 MB – disk není problém ani pro 1000 zákazníků při současném objemu dat).
- AI Coach: dnes BYOK = $0 pro provozovatele. Pokud by platil provozovatel: ~120k vstupních + 20k výstupních tokenů / uživatel / měsíc na Sonnet 5.5 ≈ $0,44 / uživatel.
- Cron zůstane na GitHub Actions (nebo se přesune – viz architektura).

## A) Minimální varianta (jen veřejná data, žádné placené feedy, BYOK AI)
| Položka | 20 | 100 | 500 | 1000 |
|---|---|---|---|---|
| Hosting frontendu (CF Pages free → Netlify/Vercel Pro) | 0 | 0 | 20 | 20 |
| Backend/DB/Auth (Supabase Pro + compute) | 25 | 25 | 40 | 85 |
| Datové licence | 0 | 0 | 0 | 0 |
| E-maily (Resend) | 0 | 20 | 20 | 35 |
| Zálohy (pg_dump do úložiště) | 0 | 5 | 10 | 10 |
| Monitoring | 0 | 0 | 26 | 26 |
| CI/cron (GitHub Team) | 4 | 4 | 4 | 4 |
| Doména | 1,5 | 1,5 | 1,5 | 1,5 |
| AI (BYOK) | 0 | 0 | 0 | 0 |
| Platební brána (Stripe) | 12 | 60 | 300 | 600 |
| **Celkem USD** | **42,5** | **115,5** | **421,5** | **781,5** |
| **Celkem Kč** | **~926** | **~2 516** | **~9 180** | **~17 021** |

## B) Profesionální varianta (placená data, PITR zálohy, monitoring, AI na účet provozovatele)
| Položka | 20 | 100 | 500 | 1000 |
|---|---|---|---|---|
| Hosting | 20 | 20 | 20 | 20 |
| Supabase Pro + compute | 40 | 40 | 85 | 85 |
| Datové licence (placeholder) | 750 | 750 | 750 | 750 |
| E-maily | 20 | 20 | 20 | 35 |
| Zálohy/PITR | 100 | 100 | 100 | 100 |
| Monitoring (Sentry + uptime) | 55 | 55 | 55 | 55 |
| CI/cron | 4 | 4 | 4 | 4 |
| Doména | 1,5 | 1,5 | 1,5 | 1,5 |
| AI (provozovatel, Sonnet 5.5) | 9 | 44 | 220 | 440 |
| Platební brána | 12 | 60 | 300 | 600 |
| **Celkem USD** | **1 011,5** | **1 094,5** | **1 555,5** | **2 090,5** |
| **Celkem Kč** | **~22 030** | **~23 840** | **~33 880** | **~45 530** |

## Závěry z čísel
1. Do ~100 zákazníků je minimální varianta řádově tisíce Kč měsíčně – **technicky levné**.
2. Dominantní nejistá položka je **licence na data** (A = 0 jen tehdy, pokud půjde provozovat s veřejnými zdroji). Profesionální variantě při $15 vychází break-even kolem **70–75 zákazníků** (1 094 / 15), minimální variantě kolem 3–8 zákazníků.
3. Není započítáno: účetní/právník/živnost, DPH (OSS), pojištění, vlastní práce, marketing, podpora.
4. Všechny částky označené NEOVĚŘENO přepsat po kontrole oficiálních ceníků.
