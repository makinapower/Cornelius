# Les agents Hermes

Cornelius peut confier des demandes longues à un agent personnel Hermes et en rapporter les réponses. Cette page explique ce qu’est Hermes, comment relier un agent à une personne, ce que Cornelius lui délègue, comment se passent les questions et les accords, et ce qui est conservé. Elle s’adresse à la personne qui règle le miroir et aux membres du foyer qui utilisent un agent.

## Ce qu’est Hermes

Hermes est un agent personnel développé par Nous Research, indépendant de Cornelius et installé à part, sur l’ordinateur du miroir ou sur une autre machine. Il a ses propres outils, services, compétences et historique : agenda, recherches, organisation de sorties, selon ce que vous y avez configuré.

Cornelius sert d’interface vocale et visuelle. Il transmet la demande à Hermes, suit son avancement et rapporte la réponse. C’est Hermes qui choisit et exécute ses outils, demande ses confirmations et gère ses tâches. Cornelius ne refait jamais une action de Hermes avec ses propres modules.

Une personne peut aussi être reliée à l’agent de code opencode à la place de Hermes : voir [L’agent de code opencode](agent-opencode.md).

La connexion est facultative et propre à chaque personne. Aucun agent n’est proposé au foyer en général, ni à un visiteur inconnu.

## Préparer Hermes

Côté Hermes, il faut activer son serveur d’API et définir un jeton, selon [sa documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/). À titre indicatif, dans la configuration de Hermes :

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=<votre-jeton-personnel>
```

puis démarrer Hermes avec `hermes gateway`. Son adresse par défaut est `http://127.0.0.1:8642`. Si Hermes tourne sur une autre machine, réglez son adresse et son accès réseau selon sa documentation. Ces réglages appartiennent à Hermes et peuvent changer avec ses versions.

Utilisez un agent ou un profil Hermes propre à chaque personne. Deux connexions vers le même compte Hermes partagent ses mémoires, ses fichiers et ses services.

## Relier un agent à une personne

Tout se fait dans la rubrique **Agents** de l’administration. Il faut d’abord au moins une personne dans le foyer.

1. Choisissez la personne dans **Agent de**.
2. Dans l’onglet **Connexion**, carte **Connexion et délégation**, renseignez **Adresse de Hermes** et **Jeton de connexion**. Un préfixe de profil comme `/p/sacha` est accepté si Hermes route ses profils ainsi. Un `/v1` final est retiré tout seul. L’adresse ne doit contenir ni paramètres ni fragment.
3. Facultatif : décrivez le rôle de l’agent dans **À quoi sert cet agent ?**, par exemple « Mon agenda, mes recherches et l’organisation des voyages ». Cela aide Cornelius à choisir quand lui confier une demande.
4. Activez **Autoriser Cornelius à contacter cet agent**.
5. Cliquez sur **Enregistrer et vérifier**.

La vérification contacte seulement les pages de découverte de Hermes : elle ne crée aucune tâche et ne fait travailler aucun modèle. Le message qui suit distingue « configuration enregistrée » et « connexion vérifiée ». Le badge de l’en-tête résume l’état : « À configurer », « Désactivé », « Connexion à vérifier », « Connexion indisponible » ou « Disponible pour Cornelius ».

« Jeton enregistré » confirme que le jeton est gardé, sans jamais le renvoyer au navigateur. Laissez le champ vide pour le conserver ; ce n’est possible qu’à la même adresse. « Modifications non enregistrées » signale une saisie pas encore enregistrée.

**Supprimer la connexion** puis **Retirer du miroir** efface la connexion et les références de tâches de cette personne dans Cornelius. Les tâches et l’historique restent dans Hermes.

## Ce que Cornelius peut déléguer

Cornelius lit ce que Hermes publie sur lui-même :

- ses capacités générales (créer, suivre et arrêter une tâche, demander un accord, recevoir une précision en cours de travail) ;
- ses groupes d’outils activés et configurés ;
- ses compétences installées, sauf celles désactivées ou indisponibles.

L’onglet **Capacités**, carte **Capacités transmises à Cornelius**, les affiche avec **Rechercher une capacité**. Une compétence installée peut encore demander un compte ou un service dans Hermes : elle ne garantit pas que la tâche réussira.

Un résumé de ces capacités et le rôle saisi sont donnés à Cornelius pendant la conversation avec la personne. Aucun résultat de tâche n’y est ajouté. Le catalogue est relu au plus toutes les cinq minutes, ou tout de suite avec **Actualiser les capacités**.

Si une partie du catalogue ne répond pas, la carte indique « Catalogue partiel » avec la cause. Les capacités reçues restent utilisables, et Cornelius n’en invente aucune. Les descriptions venues de Hermes sont traitées comme des informations, jamais comme des consignes.

## Demander à la voix

La personne doit être **seule devant le miroir et reconnue**. Avec « Cornelius » pour tout le monde, il faut donc cocher **Reconnaître la personne pendant la conversation** (voir [Ouverture et présence](ouverture-et-presence.md)).

On demande simplement : « Demande à Hermes de préparer trois idées de sorties pour samedi ». Cornelius transmet la demande, avec seulement le contexte utile. Il ne transmet ni la transcription complète, ni la mémoire personnelle, ni d’images.

La réponse immédiate donne l’état reçu de Hermes. « En attente » ou « En cours » ne veut pas dire que l’action a réussi. On peut ensuite demander où en est la tâche, apporter une précision ou demander l’arrêt.

Quand une tâche se termine plus tard, Cornelius l’annonce et affiche une carte, seulement si son propriétaire est seul et reconnu devant le miroir et que personne ne parle. La personne peut alors demander le contenu de la réponse. Un résultat n’est jamais montré à quelqu’un d’autre, et un même état n’est pas annoncé deux fois, même après un redémarrage.

## Depuis l’administration

L’onglet **Demandes** permet aussi d’échanger avec Hermes sans parler.

- **Échanger avec Hermes** : choisissez une **Conversation** (**Nouvelle demande** ou une demande existante), écrivez le **Message à Hermes**, puis **Envoyer à Hermes**.
- **Demandes récentes** : **Afficher les demandes** filtre entre « Toutes », « En cours ou à vérifier », « Accord attendu » et « Terminées ». **Actualiser les tâches** relit les états dans Hermes.
- Sur chaque demande : son état, la réponse complète, **Répondre à cette demande** et, tant qu’elle n’est pas finie, **Demander l’arrêt**.

L’en-tête compte les demandes « En cours », les « Accords attendus » et les « Capacités connues ».

## Questions et accords

Une question ordinaire de Hermes est rapportée à la personne. Elle y répond à la voix, ou avec **Répondre à cette demande** dans l’administration.

Un accord formel demandé par Hermes s’affiche dans **Agents → Demandes** sous « Hermes demande votre accord », avec le contenu de la demande :

- **Autoriser cette fois** donne l’accord pour cette opération seulement ;
- **Refuser** le refuse.

Avant de transmettre la décision, Cornelius vérifie qu’elle porte bien sur la demande en cours ; une demande remplacée ou périmée est refusée. Les accords permanents et les accords donnés par la conversation ne sont pas proposés. Si la version de Hermes ne permet pas ce relais, l’administration indique de donner l’accord directement dans Hermes.

## Quitter le miroir, redémarrer

- Quitter le miroir ou fermer la conversation n’arrête pas Hermes. Cornelius garde la référence et reprend le suivi, environ toutes les 2,5 secondes pour les tâches en cours, même après un redémarrage.
- Une demande d’arrêt est explicite. « Arrêt demandé » signifie que Hermes l’a reçue. Cela n’annule pas une action déjà faite.
- Si l’envoi d’une demande perd sa réponse, la tâche passe à « État à vérifier ». Cornelius ne la renvoie jamais tout seul : vérifiez dans Hermes.
- Hermes peut interrompre ses tâches à son propre redémarrage. Cornelius ne les relance pas.

## Données et limites

- La base de Cornelius garde, par personne, la connexion, le rôle saisi, le catalogue découvert et au plus 100 références de tâches. Une ancienne tâche terminée peut être retirée pour faire de la place ; une tâche active n’est jamais retirée.
- Le jeton est gardé sur le serveur, dans la base, **sans chiffrement**, comme celui de Home Assistant. Les copies de la base faites avant une mise à jour peuvent le contenir. Il n’est renvoyé ni à la conversation, ni au navigateur, ni au journal.
- Les messages et les réponses ne sont enregistrés ni dans la base, ni dans le journal de Cornelius. Les réponses restent en mémoire au plus quinze minutes sans nouvelle lecture.
- Hermes garde ses propres conversations et mémoires. Oublier un souvenir dans Cornelius ne les efface pas.
- Désactiver ou retirer une connexion arrête les nouvelles demandes et le suivi depuis Cornelius ; Hermes continue de gérer les tâches déjà reçues. Supprimer une personne efface ses références dans Cornelius, pas son compte Hermes.
- **Bloquer OpenAI** coupe la conversation de Cornelius, pas Hermes ni ses tâches.
- Chaque appel à Hermes attend au plus cinq secondes, lit au plus 256 Kio et refuse les redirections.

## Voir aussi

- [Ouverture et présence](ouverture-et-presence.md)
- [La mémoire](memoire.md)
- [L’administration](../utilisation/administration.md)
- [Confidentialité](../reference/confidentialite.md)
- [Documentation de Hermes : serveur d’API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
- [Documentation de Hermes : intégration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration/)
