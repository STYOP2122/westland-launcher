<?php
header('Content-Type: application/json');
require_once("query.php"); 

$server_ip = $_GET['ip'] ?? "5.129.232.53";
$server_port = $_GET['port'] ?? 7777;

$query = new Query($server_ip, $server_port); 

try { 
    $query->connect(); 
    $queryInfo = $query->getInformation(); 
    echo json_encode([
        'success' => true,
        'data' => [
            'hostname' => $queryInfo["hostname"],
            'gamemode' => $queryInfo["gamemode"],
            'players' => $queryInfo["players"],
            'max_players' => $queryInfo["max_players"]
        ]
    ]);
} catch(QueryException $error) { 
    echo json_encode([
        'success' => false,
        'error' => $error->getMessage()
    ]);
} 