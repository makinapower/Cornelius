# L’agent de code opencode

Cornelius peut confier des demandes sur un projet de code à [opencode](https://opencode.ai), un agent de code qui lit, modifie et teste les fichiers d’un dossier. On lui parle depuis le miroir (« demande à opencode de corriger le bug du formulaire »), il travaille de son côté, et Cornelius rapporte son résumé. Cette page s’adresse à la personne qui règle le miroir.

opencode se relie exactement comme un [agent Hermes](agents-hermes.md), dans la rubrique **Agents** : mêmes demandes, même suivi, mêmes accords. Une personne a un seul agent : Hermes ou opencode.

## Préparer opencode

opencode a un mode serveur, `opencode serve`. Lancez-le **dans le dossier du projet** : c’est le dossier où il travaillera.

Sur la machine du miroir :

```sh
cd ~/projets/mon-site
opencode serve
```

Sur une autre machine du réseau, il doit écouter sur le réseau ; donnez-lui alors un mot de passe :

```sh
cd ~/projets/mon-site
OPENCODE_SERVER_PASSWORD=un-long-mot-de-passe opencode serve --hostname 0.0.0.0
```

Il écoute sur le port 4096. Vérifiez depuis l’ordinateur du miroir :

```sh
curl -u opencode:un-long-mot-de-passe http://192.168.1.30:4096/global/health
```

La réponse doit contenir `"healthy":true`. opencode utilise le modèle réglé dans sa propre configuration : un modèle d’un fournisseur en ligne, ou un modèle local servi par oMLX (voir [Conversation locale](conversation-locale.md)).

## Relier opencode à une personne

Dans **Agents**, choisissez la personne dans **Agent de**, puis dans l’onglet **Connexion** :

1. **Type d’agent** : opencode.
2. **Adresse de opencode** : `http://<adresse>:4096` (ou `http://127.0.0.1:4096` sur la machine du miroir).
3. **Mot de passe (facultatif)** : celui de `OPENCODE_SERVER_PASSWORD`. Écrivez `utilisateur:mot de passe` si vous avez changé `OPENCODE_SERVER_USERNAME`. Il reste sur le serveur Cornelius et n’est jamais renvoyé au navigateur.
4. Facultatif : **À quoi sert cet agent ?**, par exemple « Le site du club de foot ».
5. Activez **Autoriser Cornelius à contacter cet agent**, puis **Enregistrer et vérifier**.

L’onglet **Capacités** montre le dossier du projet, la version d’opencode et ses agents principaux (`build`, `plan`…). Changer de type d’agent oublie dans Cornelius les références des demandes de l’ancien.

## Demander à la voix

Comme pour Hermes, la personne doit être seule devant le miroir et reconnue. Exemples :

- « Demande à opencode de corriger l’alignement du menu sur mobile. »
- « Où en est opencode ? »
- « Dis à opencode d’ajouter un test pour ça. » : une fois la demande précédente terminée, la suite continue dans la même session d’opencode, qui garde tout le contexte.
- « Arrête opencode. »

Chaque nouvelle demande ouvre une session dans opencode, intitulée « Cornelius · … ». Quand opencode a fini, Cornelius annonce le résultat et affiche son résumé ; le détail des modifications reste dans opencode (et dans Git).

## Permissions et questions

- **Permissions** : quand opencode demande la permission de faire quelque chose (modifier un fichier, lancer une commande, selon sa configuration), la demande apparaît dans **Agents → Demandes**, sous « opencode demande votre accord », avec l’action et les fichiers ou commandes concernés. **Autoriser cette fois** ou **Refuser** ; rien ne s’accorde à la voix. Les règles « toujours autoriser » se règlent dans la configuration d’opencode.
- **Questions** : quand opencode pose une question (« Quelle couleur ? »), elle est donnée quand on demande où il en est, et la réponse dite au miroir (ou écrite dans **Répondre à cette demande**) lui est transmise.

## Sécurité

- opencode agit sur les fichiers et peut lancer des commandes : réservez-le à une personne qui sait ce qu’elle lui demande, et gardez ses permissions prudentes (demander avant de modifier ou d’exécuter).
- Avec `--hostname 0.0.0.0`, mettez toujours un mot de passe. Le trafic passe en HTTP non chiffré sur le réseau de la maison ; n’exposez jamais ce port à Internet.
- Cornelius ne transmet que la demande, sans transcription complète, souvenirs ni images.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « opencode a refusé le mot de passe. » | Mauvais mot de passe, ou nom d’utilisateur changé : écrivez `utilisateur:mot de passe`. |
| « opencode est indisponible » ou connexion indisponible | `opencode serve` n’est pas lancé, écoute seulement sur `127.0.0.1`, ou un pare-feu bloque le port 4096. |
| « opencode travaille encore sur cette demande. » | On ne peut pas lui ajouter de précision pendant son travail, sauf pour répondre à sa question : attendez son résultat ou arrêtez-le. |

## Voir aussi

- [Les agents Hermes](agents-hermes.md)
- [Conversation locale](conversation-locale.md)
