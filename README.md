# git-graph

Un mod pour Claude Code : le graphe de l'historique git du projet, dans un panneau à côté de la conversation.

- **Graphe** : une couleur par branche, les merges en courbes, HEAD cerclé, les branches et tags en étiquettes, l'âge de chaque commit. Le panneau se met à jour tout seul après un commit, un checkout ou un pull.
- **Modifications en cours** : les changements pas encore commités apparaissent en tête du graphe, reliés à HEAD.
- **Détail d'un commit** : message complet, auteur, date, liens vers le commit, la pull request et les issues sur GitHub, fichiers modifiés avec leurs lignes ajoutées et supprimées.
- **Diff d'un fichier** : numéros de ligne, fonds verts et rouges, mots modifiés surlignés, coloration syntaxique (TS/JS, JSON, CSS, Markdown, SQL, YAML, shell, Python, HTML).

L'interface est en français.

## Installation

Dans une session Claude Code ouverte dans un terminal :

```
/plugin install git-graph --marketplace TerryHenrard/claude-git-graph
```

Répondez `y` pour ajouter la marketplace, puis choisissez une portée (la portée utilisateur charge le mod dans toutes vos sessions).

Depuis un shell :

```
claude plugin install git-graph --marketplace TerryHenrard/claude-git-graph
```

Dans l'application desktop, où `/plugin` ne fonctionne pas : cliquez sur **+** à côté de la zone de saisie, puis **Plugins**, **Add marketplace** avec `TerryHenrard/claude-git-graph`, puis **Add plugin**.

## Utilisation

Dans un projet git, tapez `/git-graph`. Le panneau s'ouvre ; cliquez sur une ligne pour ouvrir le commit, puis sur un fichier pour voir ses modifications.

## Développement

```
claude plugin validate .
claude plugin test .
```

## Licence

MIT
