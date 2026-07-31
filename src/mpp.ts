import type { Hono } from "hono";
import { API_CONFIG } from "./config";
import { WALLET_ADDRESS } from "./shared";

// MPP (Machine Payments Protocol, Stripe + Tempo) — spike limité à cette API.
//
// MPP et x402 partagent le même substrat de signature : la méthode `evm` de
// mppx règle en USDC sur Base avec une autorisation EIP-3009, exactement comme
// notre gate x402, vers le même wallet. Ce module n'ajoute donc qu'un second
// format de challenge HTTP -- il ne touche ni au rail de paiement, ni au
// wallet, ni au chemin x402 existant.
//
// Règle de cohabitation sur /api/rates :
//   - requête portant `payment-signature`      -> x402, on ne s'en mêle pas
//   - requête portant `Authorization: Payment` -> MPP, on vérifie et on règle
//   - requête sans credential                  -> x402 répond son 402, on y
//     ajoute le `WWW-Authenticate: Payment` pour annoncer les deux protocoles
export async function setupMpp(app: Hono) {
  const secretKey = process.env.MPP_SECRET_KEY;
  if (!secretKey) {
    console.warn("[mpp] disabled — MPP_SECRET_KEY unset");
    return;
  }

  try {
    const { Mppx, evm, tempo } = await import("mppx/server");
    const { assets } = await import("mppx/evm/server");

    const mppx = Mppx.create({
      methods: [
        ...evm({
          currency: assets.base.USDC,
          recipient: WALLET_ADDRESS as `0x${string}`,
          // Le règlement passe par un facilitator x402 : c'est le même rail que
          // le gate x402 de cette API. PayAI est retenu ici parce qu'il ne
          // demande aucune authentification -- CDP exige une clé et le spike
          // n'a pas à dépendre de sa configuration.
          x402: { facilitator: "https://facilitator.payai.network" },
        }),
        // Tempo est la chaîne où se fait la demande MPP mesurable (mppscan se
        // présente comme l'explorateur de MPP « on Tempo »). Notre adresse EVM
        // y est valide telle quelle ; aucun solde n'est requis pour encaisser,
        // aucun sponsoring de frais n'est activé.
        ...tempo({ recipient: WALLET_ADDRESS as `0x${string}` }),
      ],
      secretKey,
      realm: `${API_CONFIG.slug}.api.klymax402.com`,
    });

    // Une seule route payante ici, et les deux verbes sont au même prix.
    const route = API_CONFIG.routes[0];
    const amount = route.price.replace("$", "");

    // Avec plusieurs familles de méthodes, le raccourci `mppx.charge`
    // n'existe plus : il faut composer les intents nommés, ce qui produit un
    // challenge unique annonçant les deux méthodes. Le client choisit.
    const options = { amount, description: route.description };
    const charge = (mppx as any).compose(
      ["evm/charge", options],
      ["tempo/charge", options],
    );

    app.use("/api/rates", async (c, next) => {
      const authorization = c.req.header("authorization") ?? "";
      const hasMppCredential = /^payment\s/i.test(authorization);

      // Un client x402 doit voir exactement le comportement d'avant.
      if (c.req.header("payment-signature")) return next();

      let result: any;
      try {
        result = await charge(c.req.raw);
      } catch (e: any) {
        // Un défaut de notre côté MPP ne doit jamais casser le chemin payant
        // x402, qui est celui qui gagne de l'argent aujourd'hui.
        console.warn("[mpp] charge failed:", e?.message);
        return next();
      }

      if (result.status === 402) {
        // Credential MPP présent mais invalide/expiré : on renvoie le challenge
        // MPP, c'est ce que le client attend.
        if (hasMppCredential) return result.challenge;

        // Sinon on laisse x402 produire sa réponse et on annonce MPP à côté,
        // pour que les deux protocoles soient découvrables sur le même 402.
        await next();
        const wwwAuth = result.challenge?.headers?.get("www-authenticate");
        if (c.res.status === 402 && wwwAuth) {
          const res = new Response(c.res.body, c.res);
          res.headers.append("www-authenticate", wwwAuth);
          res.headers.set("cache-control", "no-store");
          c.res = res;
        }
        return;
      }

      // Paiement MPP accepté : on sert la ressource et on joint le reçu.
      await next();
      try {
        c.res = result.withReceipt(c.res);
      } catch (e: any) {
        console.warn("[mpp] receipt failed:", e?.message);
      }
    });

    console.log(`[mpp] enabled on /api/rates — evm(base USDC) + tempo -> ${WALLET_ADDRESS}`);
  } catch (e: any) {
    console.warn("[mpp] failed to init:", e?.message);
  }
}
