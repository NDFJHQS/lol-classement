# Classement LoL des potes

Site qui affiche le classement Solo/Duo et Flex de tes potes sur League of Legends, mis à jour automatiquement grâce à l'API officielle de Riot.

## Héberger

Le site tourne sur Render (gratuit). Variables d'environnement : `RIOT_API_KEY` (clé Riot), `ADMIN_KEY` (code pour ajouter/retirer des potes), `PLATFORM` (euw1), `REGION` (europe).

- La clé de développement Riot expire toutes les 24 h : régénère-la sur developer.riotgames.com puis mets-la à jour dans Render → Environment.
- Pour ajouter un pote définitivement : modifie `friends.json` ici (icône crayon). Render redéploie tout seul.
- Sur l'offre gratuite, le site se met en veille après 15 min sans visite (~30 s pour se réveiller).

## Lancer en local

```bash
RIOT_API_KEY=RGAPI-xxxx node server.js
```

Puis ouvre http://localhost:3000
