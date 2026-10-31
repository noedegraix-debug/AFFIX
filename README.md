# AFFIX — guide d'installation (à donner à chaque client)

Un seul service héberge tout : l'app (PC, tablette, téléphone), les comptes, messages,
retraits, et la réception des postbacks de ton réseau d'affiliation.

## Installer (10 min)
1. Crée un compte GitHub + un repo, puis envoie ces fichiers : server.js, index.html, package.json, render.yaml, et le dossier assets/ (logo + icônes).
2. Sur render.com : New → Blueprint → choisis le repo. Render crée le site ET la base de données.
   Le code admin par défaut est Admin2024 : change-le tout de suite dans Paramètres → « Changer le code d'accès admin ».
3. Ouvre l'URL du site → Espace admin → entre ton code.

## Personnaliser (dans l'app, Paramètres)
- Marque : nom, 2 couleurs, logo → appliqués partout.
- Réseau d'affiliation : copie l'URL de postback, colle-la dans ton réseau (méthode GET).
  Adapte les noms des paramètres/événements à ceux de ton réseau (ça marche avec n'importe quel réseau
  qui envoie des postbacks avec un identifiant sous-affilié).
- Crée tes sous-affiliés : leur code est ajouté à leurs liens (&s1=code).

## Variables Render
- DATABASE_URL : base Postgres (données durables). Sans elle, tout est effacé au redémarrage.
- BLUE_AFFILIATES_SECRET : optionnel, active la vérification de signature {sig} (HMAC-SHA256).

## Changer de compte Blue Affiliates
1. Paramètres → Réseau d'affiliation : copie l'URL de postback et colle-la dans la config du nouveau compte (GET, tous les événements).
2. Colle le secret HMAC du nouveau compte dans le champ « Secret HMAC » (plus besoin de modifier Render).
3. Remplace les liens de tracking des sous-affiliés par ceux du nouveau compte.

## Inscription & parrainage
- Onglet « Inscription » sur la page de connexion : le sous-affilié crée son compte (nom + mot de passe). Son code de tracking est généré automatiquement.
- Chaque membre a un lien de parrainage personnel (onglet Parrainage) : `https://ton-site/?ref=...`. Qui s'inscrit avec ce lien est rattaché à son parrain.
- Paramètres → « Inscriptions & liens de parrainage » : activer/couper les inscriptions, commission par défaut, liens donnés aux nouveaux inscrits.
- Le site est installable comme une application (bouton « Installer l'application »).

## Validation des inscriptions
- Par défaut, chaque inscription arrive « en attente » : Sous-affiliés → carte « Inscriptions à valider » → Accepter ou Refuser.
- Tant qu'un membre accepté n'a pas de lien, il voit « Patiente un peu, ton lien va arriver ». Ajoute son lien dans sa fiche (ou configure des liens par défaut dans Paramètres).
- Paramètres → « Valider manuellement chaque inscription » : décoche pour accepter automatiquement.

## Notifications push (réelles)
- Chaque membre (et l'admin) active ou désactive les notifications avec l'interrupteur « Notifications » de son tableau de bord, appareil par appareil. Un bouton « Envoyer un test » confirme que tout marche.
- Le membre est alerté : nouveau message, annonce, FTD / inscription via son lien, FTD d'un filleul, paiement effectué. L'admin est alerté : nouveau message, demande de retrait ou de reward, nouvelle inscription.
- Aucune configuration : les clés VAPID sont créées automatiquement au premier démarrage et stockées avec les données (optionnel : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).
- iPhone / iPad : les notifications ne fonctionnent que si l'app est installée sur l'écran d'accueil (iOS 16.4 minimum). Le site l'indique au membre.
- À la déconnexion, l'appareil ne reçoit plus les notifications de ce compte.
