var express = require('express');
var bodyParser = require('body-parser');
var http = require('http');
var pg = require('pg');
const { Pool, Client } = require('pg');
var path = require('path');
var app = express();
var port = process.env.NODE_PORT || 3000;
var config = require('./config/config');
const Sentry = require('@sentry/node');

config.sentryDSN = 'https://6c8d8f7f5cd14c29aa9baf455d259e27@sentry.io/1489211';
Sentry.init({ dsn: config.sentryDSN });

app.use(Sentry.Handlers.requestHandler());
app.use(bodyParser.urlencoded({ extended: false })); // parse application/x-www-form-urlencoded
app.use(bodyParser.json()); // parse application/json
app.set('view engine', 'html');

const pool = new Pool({
  connectionString: config.connectionString
});



app.get('/trees', function (req, res) {
  //console.log(req);

  let token = req.query['token'];
  let organization = req.query['organization'];
  let flavor = req.query['flavor'];
  let treeid = req.query['treeid'];
  let join = '';
  let joinCriteria = '';
  let filter = '';
  let subset = false;
  if (token) {
    join = "INNER JOIN certificates ON trees.certificate_id = certificates.id AND certificates.token = '" + token + "'";
    subset = true;
  } else if(organization) {
    join = ", certificates, donors, organizations";
    joinCriteria = "AND trees.certificate_id = certificates.id AND certificates.donor_id = donors.id AND donors.organization_id = organizations.id AND organizations.id = " + organization;
    subset = true;
  } else if (flavor) {
    join = "INNER JOIN tree_attributes ON tree_attributes.tree_id = trees.id";
    joinCriteria = "AND tree_attributes.key = 'app_flavor' AND tree_attributes.value = '" + flavor + "'";
    subset = true;
  } else if(treeid) {
    filter = 'AND trees.id = ' + treeid + ' '
    subset = true;
  }

  let bounds = req.query['bounds'];
  let boundingBoxQuery = '';
  if (bounds) {
    boundingBoxQuery = 'AND trees.estimated_geometric_location && ST_MakeEnvelope(' + bounds + ', 4326) ';
    console.log(bounds);
  }

  let clusterRadius = parseFloat(req.query['clusterRadius']);
  console.log(clusterRadius);
  var sql, query
  if (clusterRadius <= 0.001 || treeid != null ) {

    sql = `SELECT DISTINCT ON(trees.id)
    'point' AS type,
     trees.*, users.first_name as first_name, users.last_name as last_name,
    users.image_url as user_image_url
    FROM trees
    INNER JOIN users
    ON users.id = trees.user_id ` + join + `
    LEFT JOIN note_trees
    ON note_trees.tree_id = trees.id
    LEFT JOIN notes
    ON notes.id = note_trees.note_id
    WHERE active = true ` + boundingBoxQuery + filter + joinCriteria;
    console.log(sql);

    query = {
      text: sql
    }

  }
  else {

    // check if query is in the cached zone
    var boundingBox;
    var optimizedBounds;
    if(bounds) {
      boundingBox = bounds.split(',');
      optimizedBounds = config.optimizedBounds.split(',');
      console.log(boundingBox);
      console.log(optimizedBounds);
    }
   // 38.34009133803761,-2.5769945571374615,35.94562112319386,-4.088867604371135
    if( bounds && !subset
      && parseFloat(boundingBox[0]) <= parseFloat(optimizedBounds[0])
      && parseFloat(boundingBox[1]) <= parseFloat(optimizedBounds[1])
      && parseFloat(boundingBox[2]) >= parseFloat(optimizedBounds[2])
      && parseFloat(boundingBox[3]) >= parseFloat(optimizedBounds[3])){

      console.log('Using cluster cache');
      sql = `SELECT 'cluster' as type,
             St_asgeojson(location) centroid, count
             FROM clusters
             WHERE zoom_level = ` + req.query['zoom_level'] + ' AND location && ST_MakeEnvelope(' + bounds + ', 4326) ';
      query = {
        text: sql
      }
      console.log(query);

    } else {

      console.log('Calculating clusters directly');
      sql = `SELECT 'cluster'                                                   AS type,
        St_asgeojson(St_centroid(clustered_locations))                 centroid,
        St_numgeometries(clustered_locations)                          count
      FROM   (
        SELECT Unnest(St_clusterwithin(estimated_geometric_location, $1)) clustered_locations
        FROM   trees ` + join + `
        WHERE  active = true ` + boundingBoxQuery + filter + joinCriteria + ` ) clusters`;
      query = {
        text: sql,
        values: [clusterRadius]
      }
    }
  }

  pool.query(query)
    .then(function (data) {
      res.status(200).json({
        data: data.rows
      })
    })
    .catch(function(error) {
      console.error(e.stack);
      throw(error);
    });

});

app.use(Sentry.Handlers.errorHandler());

app.listen(port, () => {
  console.log('listening on port ' + port);
});
