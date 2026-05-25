# Top-level CMakeLists for the gurney-speaker firmware (ESP-IDF >= 5.1).
#
# Build:    idf.py set-target esp32s3 && idf.py build
# Flash:    idf.py -p <PORT> flash monitor
# WiFi:     credentials are read from NVS at runtime — provision once via
#           `idf.py -p <PORT> nvs-partition-gen ...` or the bundled helper
#           script (see README.md).

cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(gurney_speaker)
