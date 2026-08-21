<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.10.2" name="env" tilewidth="128" tileheight="128" tilecount="51" columns="0">
 <grid orientation="orthogonal" width="1" height="1"/>
 <properties>
  <property name="TYPE" value=""/>
 </properties>
 <tile id="0">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_BARREL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/barrel.png"/>
  <objectgroup draworder="index" id="3">
   <object id="3" name="collider" x="31" y="33" width="66" height="63"/>
  </objectgroup>
 </tile>
 <tile id="1">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_BARREL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/barrels.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="9" y="10" width="111" height="107"/>
  </objectgroup>
 </tile>
 <tile id="2">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_BARREL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/barrels_stacked.png"/>
  <objectgroup draworder="index" id="2">
   <object id="2" name="collider" x="0" y="27" width="126" height="74"/>
  </objectgroup>
 </tile>
 <tile id="3">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/campfire.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="17" y="16" width="95" height="96"/>
  </objectgroup>
 </tile>
 <tile id="4">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/chair.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="26" y="33" width="76" height="62"/>
  </objectgroup>
 </tile>
 <tile id="5">
  <properties>
   <property name="TYPE" value="CHEST"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/chest.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="15" y="23" width="98" height="82"/>
  </objectgroup>
 </tile>
 <tile id="6">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/coffin.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="20" y="1" width="88" height="127"/>
  </objectgroup>
 </tile>
 <tile id="7">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/crate.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="0" y="1" width="127" height="127"/>
  </objectgroup>
 </tile>
 <tile id="8">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/crate_small.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="30" y="30" width="67" height="67"/>
  </objectgroup>
 </tile>
  <tile id="9">
   <properties>
    <property name="TYPE" value="DOOR_CLOSED"/>
   </properties>
   <image width="128" height="128" source="../game-assets/environment/door_closed.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="125" height="46"/>
  </objectgroup>
 </tile>
 <tile id="10">
  <properties>
   <property name="TYPE" value="EXIT"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/door_open.png"/>
  <objectgroup draworder="index" id="4">
   <object id="4" name="collider" x="0.987083" y="-0.987083" width="25.6642" height="46.3929"/>
   <object id="5" name="collider" x="96.2406" y="-0.987083" width="30.5996" height="128.321"/>
  </objectgroup>
 </tile>
 <tile id="11">
  <properties>
   <property name="TYPE" value="EXIT"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/doorway.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="-2.46771" y="-6.90958" width="30.106" height="56.2637"/>
   <object id="2" name="collider" x="95.2535" y="-5.9225" width="31.0931" height="53.796"/>
  </objectgroup>
 </tile>
 <tile id="12">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/grass.png"/>
 </tile>
 <tile id="13">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/inner_diagonal.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="-1.48062" y="-3.94833" width="46.3929" height="54.2896"/>
  </objectgroup>
 </tile>
 <tile id="14">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/inner_long_diagonal.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="-2.46771" y="1.97417" width="130.295" height="43.4317"/>
  </objectgroup>
 </tile>
 <tile id="15">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/inner_long_round.png"/>
  <objectgroup draworder="index" id="3">
   <object id="3" name="collider" x="2" y="1" width="124" height="46"/>
  </objectgroup>
 </tile>
 <tile id="16">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/inner_round.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="44" height="45"/>
  </objectgroup>
 </tile>
 <tile id="17">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/path.png"/>
 </tile>
 <tile id="18">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/path_crossing.png"/>
 </tile>
 <tile id="19">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/path_curve.png"/>
 </tile>
 <tile id="20">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/planks.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="22" y="16" width="84" height="96"/>
  </objectgroup>
 </tile>
 <tile id="21">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/plants.png"/>
 </tile>
 <tile id="22">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/puddle.png"/>
 </tile>
 <tile id="23">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/stairs_down.png"/>
 </tile>
 <tile id="24">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/stairs_down_detail.png"/>
 </tile>
 <tile id="25">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tile.png"/>
 </tile>
 <tile id="26">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tiles.png"/>
 </tile>
 <tile id="27">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tiles_center.png"/>
 </tile>
 <tile id="28">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tiles_corner.png"/>
 </tile>
 <tile id="29">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tiles_cracked.png"/>
 </tile>
 <tile id="30">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tiles_decorative.png"/>
 </tile>
 <tile id="31">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/track.png"/>
 </tile>
 <tile id="32">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/track_crossing.png"/>
 </tile>
 <tile id="33">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/track_curve.png"/>
 </tile>
 <tile id="34">
  <properties>
   <property name="TYPE" value="TRAP_SPIKE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/trap.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="22" y="22" width="92" height="84"/>
  </objectgroup>
 </tile>
 <tile id="35">
  <properties>
   <property name="TYPE" value="TRAP_TELEPORT"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/trap_door.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="0" y="1" width="127" height="127"/>
  </objectgroup>
 </tile>
 <tile id="36">
  <properties>
   <property name="TYPE" value="TRAP_FIRE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/trapdoor_round.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="21" y="22" width="86" height="84"/>
  </objectgroup>
 </tile>
 <tile id="37">
  <properties>
   <property name="TYPE" value="TRAP_FIRE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/trapdoor_square.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="20" y="21" width="87" height="87"/>
  </objectgroup>
 </tile>
 <tile id="38">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_CRATE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/tree.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="3" width="125" height="124"/>
  </objectgroup>
 </tile>
 <tile id="39">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="125" height="46"/>
  </objectgroup>
 </tile>
 <tile id="40">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_corner.png"/>
  <objectgroup draworder="index" id="2">
   <object id="2" name="collider" x="41.4575" y="124.372">
    <polygon points="0,0 -36.0285,-0.493542 -40.4704,-120.918 80.9408,-121.905 83.4085,-80.9408 1.97417,-80.4473"/>
   </object>
  </objectgroup>
 </tile>
 <tile id="41">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_curve.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2.96125" y="124.866">
    <polygon points="0,0 16.2869,-80.9408 64.6539,-114.502 119.931,-118.944 119.437,-80.4473 66.6281,-63.6669 44.9123,-26.6512 42.4446,-3.45479"/>
   </object>
  </objectgroup>
 </tile>
 <tile id="42">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_damaged.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="125" height="47"/>
  </objectgroup>
 </tile>
 <tile id="43">
  <properties>
   <property name="TYPE" value="EXIT"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_demolished.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="1.48062" y="-4.44187" width="26.1577" height="52.3154"/>
   <object id="2" name="collider" x="101.176" y="-3.94833" width="25.1706" height="52.8089"/>
  </objectgroup>
 </tile>
 <tile id="44">
  <properties>
   <property name="TYPE" value="INDESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_diagonal.png"/>
  <objectgroup draworder="index" id="3">
   <object id="2" name="collider" x="3.45479" y="121.411">
    <polygon points="0,0 0,-17.274 105.124,-120.918 122.398,-120.918 123.385,-79.4602 46.8864,1.48062"/>
   </object>
  </objectgroup>
 </tile>
 <tile id="45">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_edge.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="1.97417" y="121.905">
    <polygon points="0,0 42.9381,2.96125 41.951,-72.0571 61.1992,-77.9796 122.398,-78.4731 123.879,-122.398 26.6512,-118.944 2.46771,-88.8375"/>
   </object>
  </objectgroup>
 </tile>
 <tile id="46">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_half.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="66" height="46"/>
  </objectgroup>
 </tile>
 <tile id="47">
  <properties>
   <property name="TYPE" value="DESTRUCTIBLE_WALL"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_secret.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="2" width="125" height="44"/>
  </objectgroup>
 </tile>
 <tile id="48">
  <properties>
   <property name="TYPE" value="TRAP_SPIKE"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wall_trap.png"/>
  <objectgroup draworder="index" id="2">
   <object id="1" name="collider" x="2" y="1" width="125" height="75"/>
  </objectgroup>
 </tile>
 <tile id="49">
  <properties>
   <property name="TYPE" value=""/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/water.png"/>
 </tile>
 <tile id="50">
  <properties>
   <property name="TYPE" value="EMPTY"/>
  </properties>
  <image width="128" height="128" source="../game-assets/environment/wood.png"/>
 </tile>
</tileset>
